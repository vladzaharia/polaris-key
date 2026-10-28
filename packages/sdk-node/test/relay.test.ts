// @pkey-feature connect.relay connect.app connect.protocol
// Cloud Connect over the relay and the cloudConnect facade (CC-08.3; WIRE-CONTRACT-V5 §15.7): the
// ticket, the envelope framing, sessions admitted exactly as on the LAN, the LAN-then-relay order,
// reconnect with backoff, the typed quota and pause errors, and the rule that modes `v` and `p`
// never cross the relay. The room is a faithful in-process copy of the CC-07 engine's framing
// (relayFixtures.ts).
import { describe, expect, it } from "vitest";
import { PolarisError } from "@polaris-key/client-core";
import { signJws } from "@polaris-key/jws";
import { ISSUER } from "@polaris-key/protocol/core";
import {
  PeerChannel,
  accountInstance,
  advertEpoch,
  webCryptoNoisePorts,
} from "@polaris-key/client-core/peer";
import type { PolarisKeyClient } from "../src/client.js";
import {
  LanError,
  RELAY_MODES,
  RelayError,
  assertRelayMode,
  type ConnectNotice,
  type ConnectSession,
} from "../src/connect/index.js";
import {
  MemoryMdnsNetwork,
  PRODUCT,
  T0,
  devId,
  loopLan,
  makeClient,
  sleep,
  text,
  until,
  utf8,
} from "./lanFixtures.js";
import { FakeRoom, ManualTimer, relayHarness } from "./relayFixtures.js";
import { TEST_KID, TEST_PEM, TEST_PUB } from "./parityFixtures.js";

const A = devId("1");
const B = devId("2");
const { dirs, clients, world, svc } = relayHarness();

const relayOnly = (room: FakeRoom, extra: object = {}) => ({
  lan: false as const,
  relay: { webSocket: room.webSocket, ...extra },
});

/** A open session pair over the relay: `out` is B's, `inn` is A's. */
async function relayPair(
  a: PolarisKeyClient,
  b: PolarisKeyClient,
  room: FakeRoom,
) {
  let inn: ConnectSession | null = null;
  a.cloudConnect.onChannel((s) => (inn = s));
  await a.cloudConnect.start(relayOnly(room));
  await b.cloudConnect.start(relayOnly(room));
  await until(() => b.cloudConnect.peers().some((p) => p.deviceId === A));
  const out = await b.cloudConnect.open(A);
  await until(() => inn !== null);
  return { out, inn: inn! as ConnectSession };
}

describe("the ticket", () => {
  it("is a pkeyrt_ ticket for the Worker's own wss host, offered as the second subprotocol", async () => {
    const { a, room, worker } = await world();
    const g = await a.connect.relayTicket();
    expect(g).toMatchObject({
      url: `wss://k.test/${PRODUCT}/connect/relay`,
      protocol: "pkey-relay.1",
    });
    expect(g.ticket).toMatch(/^pkeyrt_[A-Za-z0-9_-]{32}$/);
    expect(g.expiresAt).toBe(T0 + 60);

    await a.cloudConnect.start(relayOnly(room));
    await until(() => room.offered.length === 1);
    expect(room.offered[0]![0]).toBe("pkey-relay.1");
    expect(room.offered[0]![1]).toMatch(/^pkeyrt_/);
    expect(worker.ticketsAsked).toBe(2);
  });

  it.each([
    ["a foreign host", "wss://evil.test/djdl/connect/relay"],
    ["a clear-text scheme", "ws://k.test/djdl/connect/relay"],
  ])("refuses an answer with %s", async (_n, url) => {
    const { a, worker } = await world();
    worker.relayUrl = url;
    await expect(a.connect.relayTicket()).rejects.toMatchObject({
      name: "RelayError",
      reason: "ticket_invalid",
    });
  });

  it("the errors are PolarisErrors with registered codes", async () => {
    const { a, worker } = await world();
    const codes: [typeof worker.relay, string][] = [
      ["disabled", "relay_disabled"],
      ["paused", "relay_paused"],
      ["quota-person", "relay_quota_exceeded"],
    ];
    for (const [mode, code] of codes) {
      worker.relay = mode;
      const e = await a.connect.relayTicket().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(PolarisError);
      expect(e).toBeInstanceOf(RelayError);
      expect(e).toMatchObject({ code });
    }
    await expect(a.cloudConnect.open(B)).rejects.toMatchObject({
      name: "LanError",
      code: "not-configured",
    });
    expect(new LanError("wrong_peer", "x")).toBeInstanceOf(PolarisError);
    expect(new LanError("wrong_peer", "x").code).toBe("peer-cert-invalid");
    expect(new RelayError("not_connected", "x").code).toBe(
      "connect-unavailable",
    );
  });

  it("types the refusals: product off, paused with Retry-After, quota with its scope", async () => {
    const { a, worker } = await world();
    worker.relay = "disabled";
    await expect(a.connect.relayTicket()).rejects.toMatchObject({
      reason: "disabled",
    });
    worker.relay = "paused";
    await expect(a.connect.relayTicket()).rejects.toMatchObject({
      reason: "paused",
      retryAfterSeconds: 300,
    });
    worker.relay = "quota-person";
    await expect(a.connect.relayTicket()).rejects.toMatchObject({
      reason: "quota",
      scope: "person",
    });
    worker.relay = "quota-product";
    await expect(a.connect.relayTicket()).rejects.toMatchObject({
      reason: "quota",
      scope: "product",
    });
  });
});

describe("sessions over the relay", () => {
  it("admits the peer like the LAN does and carries messages both ways", async () => {
    const { a, b, room } = await world();
    const { out, inn } = await relayPair(a, b, room);
    expect(out.path).toBe("relay");
    expect(inn.path).toBe("relay");
    expect(out.peerDeviceId).toBe(A);
    expect(inn.peerDeviceId).toBe(B);
    await out.send(utf8("over the room"));
    expect(text((await inn.receive()).body)).toBe("over the room");
    await inn.send(utf8("and back"), 0x0102);
    expect(await out.receive()).toMatchObject({ type: 0x0102 });
    // A message bigger than one frame is split into records and reassembled.
    const big = new Uint8Array(200_000).fill(7);
    await out.send(big);
    expect((await inn.receive()).body.length).toBe(200_000);
    // The client only ever wrote SEND, LIST and PING; the room stamped `from`.
    for (const r of room.received)
      expect(["send", "list", "ping"]).toContain(r.msg.op);
    expect(room.sends(B).length).toBeGreaterThan(0);
    await out.close();
    await until(() => inn.closed !== null);
  });

  it("ignores a CANDIDATES record: not delivered, session stays open (§15.6 defines no client action)", async () => {
    const { a, b, room } = await world();
    const { out, inn } = await relayPair(a, b, room);
    await out.sendRecord(
      0x0006,
      utf8(JSON.stringify({ addrs: ["192.168.1.9:4000", "8.8.8.8:1"] })),
    );
    await out.send(utf8("after"));
    expect(text((await inn.receive()).body)).toBe("after");
    expect(inn.closed).toBeNull();
    await out.close();
  });

  it("refuses a peer of another account", async () => {
    const { a, room, worker } = await world();
    const stranger = await makeClient(worker, "9", dirs);
    clients.push(stranger);
    worker.subs.set(devId("9"), "ps_BBBBBBBBBBBBBBBBBBBBBB");
    await stranger.connect.identity();
    await a.cloudConnect.start(relayOnly(room));
    await stranger.cloudConnect.start(relayOnly(room));
    await until(() => stranger.cloudConnect.peers().length >= 0);
    await expect(stranger.cloudConnect.open(A)).rejects.toMatchObject({
      name: "RelayError",
      reason: "unknown_peer",
    });
  });

  it("ignores a first message from a device that is not on the roster", async () => {
    const { a, room, worker } = await world();
    let got = 0;
    a.cloudConnect.onChannel(() => got++);
    await a.cloudConnect.start(relayOnly(room));
    await until(() => room.sockets.length === 1);
    worker.members.set(devId("7"), { signKey: "x", agreeKey: "y" });
    room.inject(devId("7"), A, 1, new Uint8Array(48).fill(1));
    await sleep(60);
    expect(got).toBe(0);
    expect(room.sends(A)).toHaveLength(0);
  });
});

describe("LAN first, then the relay", () => {
  async function both(
    room: FakeRoom,
    net: MemoryMdnsNetwork,
    a: PolarisKeyClient,
    b: PolarisKeyClient,
    bLan = true,
  ) {
    const lan = loopLan(net);
    await a.cloudConnect.start({ lan, relay: { webSocket: room.webSocket } });
    await b.cloudConnect.start({
      lan: bLan ? lan : false,
      relay: { webSocket: room.webSocket },
    });
  }

  async function lanWorld() {
    const w = await world();
    const net = new MemoryMdnsNetwork();
    await both(w.room, net, w.a, w.b);
    await until(() => w.a.cloudConnect.peers().some((p) => p.lan));
    return { ...w, net };
  }

  it("uses the LAN when the device is on the network", async () => {
    const { a, b, room } = await lanWorld();
    await a.cloudConnect.refreshPeers();
    expect(a.cloudConnect.peers().find((p) => p.deviceId === B)).toMatchObject({
      lan: true,
      relay: true,
    });
    const s = await a.cloudConnect.open(B);
    expect(s.path).toBe("lan");
    expect(room.sends(A)).toHaveLength(0);
  });

  it("goes straight to the relay for a device not seen on the LAN", async () => {
    const { a, b, room } = await world();
    await both(room, new MemoryMdnsNetwork(), a, b, false);
    await until(() => room.sockets.length === 2);
    await a.cloudConnect.refreshPeers();
    expect(a.cloudConnect.peers()[0]).toMatchObject({
      lan: false,
      relay: true,
    });
    const s = await a.cloudConnect.open(B);
    expect(s.path).toBe("relay");
  });

  it("falls back to the relay after a failed LAN attempt, and not when the host disabled it", async () => {
    const { a, room, net } = await lanWorld();
    // B's advert now points at a port nobody listens on.
    const keys = (await a.connect.discoveryKeys())!;
    const name = await accountInstance(keys.current, advertEpoch(T0), B);
    net.inject({
      instance: name,
      host: "127.0.0.1",
      port: 9,
      txt: ["v=1", "m=a"],
    });
    await until(
      () => a.cloudConnect.peers().find((p) => p.deviceId === B)?.lan === true,
    );
    await sleep(20);
    const s = await a.cloudConnect.open(B, { lanAttemptMs: 2000 });
    expect(s.path).toBe("relay");
    await expect(
      a.cloudConnect.open(B, { relay: false }),
    ).rejects.toBeInstanceOf(LanError);
  });

  it("with the relay off, opens no relay socket and asks for no ticket", async () => {
    const { a, b, room, worker } = await world();
    const net = new MemoryMdnsNetwork();
    const lan = loopLan(net);
    await a.cloudConnect.start({ lan, relay: false });
    await b.cloudConnect.start({ lan, relay: false });
    await until(() => a.cloudConnect.peers().some((p) => p.deviceId === B));
    expect(a.cloudConnect.status().relay).toBe("off");
    expect((await a.cloudConnect.open(B)).path).toBe("lan");
    expect(worker.ticketsAsked).toBe(0);
    expect(room.everOpened).toHaveLength(0);
    await b.cloudConnect.stop();
    await expect(a.cloudConnect.open(devId("3"))).rejects.toBeInstanceOf(
      LanError,
    );
  });
});

describe("reconnect and the typed stops", () => {
  it("reconnects with a growing, jittered backoff and a fresh ticket each time", async () => {
    const { a, room, worker } = await world();
    const t = new ManualTimer();
    // `stableMs: 0`: every open counts as stable, so the delay restarts each time.
    const r = svc(a, room, t, { stableMs: 0 });
    await r.ready();
    expect(worker.ticketsAsked).toBe(1);
    // The room drops the socket; the session on it ends as connection_lost.
    room.dropAll(1006);
    await until(() => r.status.state === "backoff");
    // Attempt 1: base 1 s, equal jitter at 0.5 gives 750 ms.
    expect(t.delays.filter((d) => d === 750)).toHaveLength(1);
    expect(t.fire((ms) => ms === 750)).toBe(true);
    await r.ready();
    expect(worker.ticketsAsked).toBe(2);
    // A failed attempt (the room refuses) doubles the delay: 1.5 s.
    room.rejectWith = 4001;
    room.dropAll(1006);
    await until(() => r.status.state === "backoff");
    expect(t.fire((ms) => ms === 750)).toBe(true);
    await until(() => t.pending.some((p) => p.ms === 1500));
    expect(t.fire((ms) => ms === 1500)).toBe(true);
    await r.ready();
    expect(worker.ticketsAsked).toBe(4);
    expect(r.status.attempts).toBe(2);
  });

  it("ends a session on the dropped socket with connection_lost", async () => {
    const { a, b, room } = await world();
    const { out, inn } = await relayPair(a, b, room);
    const seen: string[] = [];
    out.onClose((c) => seen.push(c.code));
    inn.onClose((c) => seen.push(c.code));
    room.dropAll(1006);
    await until(() => seen.length === 2);
    expect(seen).toEqual(["connection_lost", "connection_lost"]);
    await expect(out.send(utf8("x"))).rejects.toMatchObject({
      reason: "closed",
    });
  });

  it("does not fight back when the room says it replaced this socket (4009)", async () => {
    const { a, room, worker } = await world();
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await r.ready();
    room.dropAll(4009);
    await until(() => r.status.state === "blocked");
    expect(r.status.error).toMatchObject({ reason: "replaced" });
    await sleep(30);
    expect(worker.ticketsAsked).toBe(1);
  });

  it("a product that turned the relay off, or a spent quota, ends the loop with the typed error", async () => {
    const { a, room, worker } = await world();
    worker.relay = "quota-product";
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await until(() => r.status.state === "blocked");
    expect(r.status.error).toMatchObject({ reason: "quota", scope: "product" });
    await expect(r.ready()).rejects.toMatchObject({ reason: "quota" });
    // Back to normal: resume() asks again.
    worker.relay = "ok";
    r.resume();
    await r.ready();
    expect(r.status.state).toBe("open");

    worker.relay = "disabled";
    const r2 = svc(a, room, t);
    await until(() => r2.status.state === "blocked");
    expect(r2.status.error).toMatchObject({ reason: "disabled" });
  });

  it("a paused relay waits for Retry-After, then tries again", async () => {
    const { a, room, worker } = await world();
    worker.relay = "paused";
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await until(() => r.status.state === "backoff");
    expect(r.status.error).toMatchObject({
      reason: "paused",
      retryAfterSeconds: 300,
    });
    expect(t.delays).toContain(300_000);
    worker.relay = "ok";
    expect(t.fire((ms) => ms === 300_000)).toBe(true);
    await r.ready();
  });

  it("a LIMIT for the product, then 4008, is a typed quota stop", async () => {
    const { a, room } = await world();
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await r.ready();
    for (const s of room.sockets) s.deliver({ op: "limit", reason: 3 });
    await sleep(20);
    room.dropAll(4008);
    await until(() => r.status.state === "blocked");
    expect(r.status.error).toMatchObject({ reason: "quota", scope: "product" });
  });

  it("closes 1002 on an envelope that does not match its layout, and answers nothing", async () => {
    const { a, room } = await world();
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await r.ready();
    const before = room.received.length;
    for (const s of room.sockets) s.deliver(Uint8Array.of(0x99, 1, 2, 3));
    await until(() => room.everOpened[0]!.closeCode === 1002);
    expect(room.received.length).toBe(before);
  });
});

describe("modes v and p never cross the relay", () => {
  it("is mode a only, and refuses any other", () => {
    expect([...RELAY_MODES]).toEqual(["a"]);
    expect(assertRelayMode("a")).toBe("a");
    for (const m of ["v", "p", "x", ""])
      expect(() => assertRelayMode(m)).toThrow(RelayError);
    expect(() => assertRelayMode("v")).toThrow(/never crosses the relay/);
  });

  it.each(["v", "p"] as const)(
    "a mode %s handshake that arrives through the room opens no session and gets no answer",
    async (mode) => {
      const { a, room, worker } = await world();
      let sessions = 0;
      a.cloudConnect.onChannel(() => sessions++);
      await a.cloudConnect.start(relayOnly(room));
      await until(() => room.sockets.length === 1);
      // A hostile (or confused) device of the same person starts a v or p handshake.
      worker.members.set(B, worker.members.get(B)!);
      const msgs: Uint8Array[] = [];
      const ch = new PeerChannel({
        mode,
        role: "initiator",
        slug: PRODUCT,
        staticKey: crypto.getRandomValues(new Uint8Array(32)),
        hello: { platform: "test", app: PRODUCT },
        ports: webCryptoNoisePorts,
        send: (n) => msgs.push(n),
        onEvent: () => undefined,
      });
      await ch.start();
      expect(msgs).toHaveLength(1);
      room.inject(B, A, 77, msgs[0]!);
      await sleep(80);
      expect(sessions).toBe(0);
      expect(room.sends(A)).toHaveLength(0);
      await ch.close();
    },
  );
});

describe("pushed documents", () => {
  async function staleA() {
    const w = await world();
    // A third device joins; B fetches the new roster, A does not.
    const c = await makeClient(w.worker, "3", dirs);
    clients.push(c);
    await c.connect.identity();
    await w.b.connect.identity({ refresh: true });
    const held = (await w.a.connect.current())!.epoch;
    expect((await w.b.connect.current())!.epoch).toBeGreaterThan(held);
    return { ...w, held };
  }

  it("a peer on a newer roster makes the transport fetch it", async () => {
    const { a, b, room, worker, held } = await staleA();
    const before = worker.identityCalls;
    const { out } = await relayPair(a, b, room).catch(async () => {
      throw new Error("pair");
    });
    await until(() => worker.identityCalls > before);
    await sleep(50);
    expect((await a.connect.current())!.epoch).toBeGreaterThan(held);
    void out;
  });

  it("a relay RING op above the held epoch fetches the roster; one at the held epoch does not", async () => {
    const { a, room, worker, held } = await staleA();
    await a.cloudConnect.start(relayOnly(room));
    await until(() => room.sockets.length === 1);
    const before = worker.identityCalls;
    room.pushRing(held);
    await sleep(60);
    expect(worker.identityCalls).toBe(before);
    room.pushRing(held + 1);
    await until(() => worker.identityCalls > before);
    await sleep(30);
    expect((await a.connect.current())!.epoch).toBe(held + 1);
  });

  it("a verified RING a peer pushes is stored in the connect state even when the fetch fails", async () => {
    const { a, b, room, worker, held } = await staleA();
    worker.failIdentity = true;
    const notes: ConnectNotice[] = [];
    a.cloudConnect.onNotice((n) => notes.push(n));
    await relayPair(a, b, room);
    await until(() => notes.some((n) => n.type === "ring"));
    expect(notes).toContainEqual({
      type: "ring",
      outcome: "stored",
      epoch: held + 1,
    });
    expect((await a.connect.current())!.epoch).toBe(held + 1);
    // The certificate still names the old epoch, so the next identity() fetches a fresh one.
    worker.failIdentity = false;
    const id = await a.connect.identity();
    expect(id.epoch).toBe(held + 1);
  });

  it("refuses a pushed roster it cannot store, with the reason", async () => {
    const { a, b, worker } = await staleA();
    const ring = await worker.ring((await b.connect.current())!.sub);
    expect(await a.connect.adoptRing(ring)).toMatchObject({ stored: true });
    // The same epoch again, a garbled document, and a roster that drops this device.
    expect(await a.connect.adoptRing(ring)).toEqual({
      stored: false,
      reason: "epoch-not-higher",
    });
    expect(await a.connect.adoptRing(ring.slice(0, -4) + "AAAA")).toEqual({
      stored: false,
      reason: "new-rejected",
    });
    worker.members.delete(A);
    worker.epoch += 5;
    const without = await worker.ring((await b.connect.current())!.sub);
    expect(await a.connect.adoptRing(without)).toEqual({
      stored: false,
      reason: "device_not_in_roster",
    });
    expect(
      (await a.connect.current())!.devices.map((d) => d.deviceId),
    ).toContain(A);
  });

  async function trustDoc(issuedAt: number, kid = TEST_KID): Promise<string> {
    return signJws(
      {
        schemaVersion: 1,
        aud: PRODUCT,
        iss: ISSUER,
        issuedAt,
        expiresAt: issuedAt + 300,
        jwksUrl: `https://k.test/${PRODUCT}/.well-known/jwks.json`,
        cacheSeconds: 300,
        keys: [
          {
            kid,
            alg: "EdDSA",
            kty: "OKP",
            crv: "Ed25519",
            publicKey: TEST_PUB,
            status: "active",
          },
        ],
      },
      TEST_PEM,
      kid,
      "pkey-trust+jws",
    );
  }

  /** The peer pushes a TRUST record on an open session (host code cannot; the test reaches in). */
  async function pushTrust(from: ConnectSession, jws: string): Promise<void> {
    await from.sendRecord(0x0003, utf8(JSON.stringify({ trust: jws })));
  }

  it("a peer's TRUST manifest is verified and applied, or refused with a reason", async () => {
    const { a, b, room } = await world(true);
    const notes: ConnectNotice[] = [];
    a.cloudConnect.onNotice((n) => notes.push(n));
    const { out } = await relayPair(a, b, room);
    const good = await trustDoc(T0 - 10);
    await pushTrust(out, good);
    await until(() => notes.length === 1);
    expect(notes[0]).toEqual({ type: "trust", outcome: "applied" });
    // The same manifest again is not newer; garbage does not verify.
    await pushTrust(out, good);
    await until(() => notes.length === 2);
    expect(notes[1]).toEqual({
      type: "trust",
      outcome: "refused",
      reason: "not_newer",
    });
    await pushTrust(out, "not.a.jws");
    await until(() => notes.length === 3);
    expect(notes[2]).toEqual({
      type: "trust",
      outcome: "refused",
      reason: "invalid",
    });
    // The applied manifest is what the cache holds.
    const cache = (
      a as unknown as { cache: { trustJws(): string | undefined } }
    ).cache;
    expect(cache.trustJws()).toBe(good);
  });

  it("a host that turned trust refresh off refuses a peer's TRUST, visibly", async () => {
    const { a, b, room } = await world(false);
    const notes: ConnectNotice[] = [];
    a.cloudConnect.onNotice((n) => notes.push(n));
    const { out } = await relayPair(a, b, room);
    await pushTrust(out, await trustDoc(T0 - 10));
    await until(() => notes.length === 1);
    expect(notes[0]).toEqual({
      type: "trust",
      outcome: "refused",
      reason: "trust_refresh_off",
    });
  });
});

describe("the facade", () => {
  it("lists devices, reports status and refuses open before start", async () => {
    const { a, room } = await world();
    await expect(a.cloudConnect.open(B)).rejects.toMatchObject({
      reason: "not_started",
    });
    expect(a.cloudConnect.status()).toMatchObject({
      running: false,
      lan: "off",
      relay: "off",
    });
    await a.cloudConnect.start(relayOnly(room));
    await until(() => a.cloudConnect.status().relay === "open");
    expect(a.cloudConnect.status()).toMatchObject({
      running: true,
      relay: "open",
    });
  });
});

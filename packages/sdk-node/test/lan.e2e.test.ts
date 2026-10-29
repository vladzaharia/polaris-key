// @pkey-feature connect.lan
// Cloud Connect LAN, end to end in one process (CC-08.2; WIRE-CONTRACT-V5 §15.4 to §15.6): two
// clients on 127.0.0.1 find each other through an in-process mDNS network, handshake (Noise
// XXpsk0 with the certificate and roster checks), exchange messages both ways, rekey and close.
// The real `multicast-dns` socket is covered in connectMdns.test.ts (skipped there when the
// sandbox has no multicast). Negative cases: a foreign roster, an expired certificate, a wrong
// K_disc, oversized frames, flooding and a stalled handshake.
import { connect as tcp, createServer, type Socket } from "node:net";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64UrlDecode } from "@polaris-key/jws";
import { accountInstance, advertEpoch } from "@polaris-key/client-core/peer";
import type { PolarisKeyClient } from "../src/client.js";
import {
  LanError,
  LanService,
  type LanSource,
  type ConnectSession,
} from "../src/connect/index.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  SUB,
  T0,
  devId,
  makeClient,
  sleep,
  text,
  until,
  utf8,
} from "./lanFixtures.js";

const A = devId("1");
const B = devId("2");

let dirs: string[] = [];
let services: LanService[] = [];
let sockets: Socket[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  await Promise.all(services.splice(0).map((s) => s.stop()));
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

async function lan(
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  extra: Parameters<PolarisKeyClient["connect"]["lan"]>[0] = {},
): Promise<LanService> {
  const s = await c.connect.lan({ mdns: net.adapter(), ...LOOP, ...extra });
  services.push(s);
  return s;
}

async function world() {
  const worker = new MultiWorker();
  const a = await makeClient(worker, "1", dirs);
  const b = await makeClient(worker, "2", dirs);
  await a.connect.identity();
  await b.connect.identity();
  await a.connect.identity({ refresh: true });
  return { worker, a, b, net: new MemoryMdnsNetwork() };
}

/** Both ends of one admitted session. */
async function pair(
  la: LanService,
  lb: LanService,
): Promise<{ out: ConnectSession; inn: ConnectSession }> {
  let inn: ConnectSession | null = null;
  la.onSession((s) => (inn = s));
  await until(() => lb.peers().some((p) => p.deviceId === A));
  const out = await lb.connect(A);
  await until(() => inn !== null);
  return { out, inn: inn! };
}

describe("LAN discovery and sessions", () => {
  it("finds the other device, handshakes, sends both ways, rekeys and closes", async () => {
    const { a, b, net } = await world();
    const la = await lan(a, net, { rekeyMessages: 3 });
    const lb = await lan(b, net, { rekeyMessages: 3 });
    await until(() => la.peers().length === 1 && lb.peers().length === 1);
    expect(la.peers()[0]!.deviceId).toBe(B);
    expect(lb.peers()[0]).toMatchObject({
      deviceId: A,
      host: "127.0.0.1",
      port: la.port,
    });

    // The advert carries the account instance name and `v=1`, `m=a` only.
    const keys = (await a.connect.discoveryKeys())!;
    const name = await accountInstance(keys.current, advertEpoch(T0), A);
    expect(net.adverts.get(name)).toMatchObject({
      port: la.port,
      txt: ["v=1", "m=a"],
    });
    expect(la.port).not.toBe(lb.port);

    const { out, inn } = await pair(la, lb);
    expect(out.peerDeviceId).toBe(A);
    expect(inn.peerDeviceId).toBe(B);
    expect(out.caps).toEqual(["app/1"]);
    expect(out.role).toBe("initiator");

    await out.send(utf8("hello from b"));
    expect(text((await inn.receive()).body)).toBe("hello from b");
    await inn.send(utf8("hello from a"), 0x0101);
    expect(await out.receive()).toMatchObject({ type: 0x0101 });

    // More than the rekey threshold in each direction: the keys change under the traffic.
    for (let i = 0; i < 8; i++) {
      await out.send(utf8(`b${i}`));
      await inn.send(utf8(`a${i}`));
    }
    for (let i = 0; i < 8; i++) {
      expect(text((await inn.receive()).body)).toBe(`b${i}`);
    }
    for (let i = 0; i < 8; i++) {
      expect(text((await out.receive()).body)).toBe(`a${i}`);
    }
    const order: string[] = [];
    inn.onClose((c) => order.push(`inn:${c.code}:${c.byPeer}`));
    out.onClose((c) => order.push(`out:${c.code}:${c.byPeer}`));
    await out.close();
    await until(() => order.length === 2);
    expect(order.sort()).toEqual(["inn:peer_bye:true", "out:peer_bye:false"]);
    await expect(out.send(utf8("x"))).rejects.toMatchObject({
      reason: "closed",
    });
    await expect(inn.receive()).rejects.toMatchObject({ reason: "closed" });
  });

  it("reassembles a 1 MiB message and refuses a larger one", async () => {
    const { a, b, net } = await world();
    const la = await lan(a, net);
    const lb = await lan(b, net);
    const { out, inn } = await pair(la, lb);
    const big = new Uint8Array(1_048_576).map((_, i) => i % 251);
    await out.send(big);
    const got = await inn.receive();
    expect(got.body.length).toBe(big.length);
    expect(got.body[777_777]).toBe(big[777_777]);
    await expect(out.send(new Uint8Array(1_048_577))).rejects.toMatchObject({
      reason: "too_large",
    });
    await expect(out.send(utf8("x"), 0x8100)).rejects.toMatchObject({
      reason: "bad_type",
    });
    expect(out.closed).toBeNull();
  });

  it("rotates the advert at the epoch boundary and drops the old one", async () => {
    const worker = new MultiWorker();
    const net = new MemoryMdnsNetwork();
    const key = base64UrlDecode(worker.disc);
    let now = T0;
    const timers: { fn: () => void; ms: number }[] = [];
    const src: LanSource = {
      now: () => now,
      load: async () => ({
        slug: "djdl",
        trust: {},
        sub: SUB,
        deviceId: A,
        certJws: "x",
        certExpiresAt: now + 100_000,
        ringJws: "x",
        ringEpoch: 1,
        roster: [A, B],
        keys: { current: key, previous: null },
        agreePublic: new Uint8Array(32),
        dh: async () => null,
      }),
    };
    const svc = await LanService.start(src, {
      ...LOOP,
      mdns: net.adapter(),
      browse: false,
      timer: (fn, ms) => {
        timers.push({ fn, ms });
        return () => undefined;
      },
    });
    services.push(svc);
    const first = await accountInstance(key, advertEpoch(T0), A);
    expect([...net.adverts.keys()]).toEqual([first]);
    // The timer fires at the next 900-second boundary.
    const t = timers.at(-1)!;
    expect(t.ms).toBe(((advertEpoch(T0) + 1) * 900 - T0) * 1000);
    now = (advertEpoch(T0) + 1) * 900;
    t.fn();
    const second = await accountInstance(key, advertEpoch(now), A);
    await until(() => net.adverts.has(second));
    await until(() => !net.adverts.has(first));
    expect(second).not.toBe(first);
    expect(net.log).toEqual([`up ${first}`, `up ${second}`, `down ${first}`]);
    expect(timers.at(-1)!.ms).toBe(900_000);
  });

  it("drops adverts that do not verify", async () => {
    const { a, net, worker } = await world();
    const la = await lan(a, net);
    const right = await accountInstance(
      base64UrlDecode(worker.disc),
      advertEpoch(T0),
      B,
    );
    const wrongKey = await accountInstance(
      new Uint8Array(32).fill(7),
      advertEpoch(T0),
      B,
    );
    const me = await accountInstance(
      base64UrlDecode(worker.disc),
      advertEpoch(T0),
      A,
    );
    const f = (instance: string, o: Record<string, unknown> = {}) =>
      net.inject({
        instance,
        hosts: ["127.0.0.1"],
        port: 4000,
        txt: ["v=1", "m=a"],
        ...o,
      });
    f(wrongKey);
    f(me); // this device's own advert is not a peer
    f(right, { txt: ["v=1", "m=v", "h=0123456789abcdef"] }); // wrong mode
    f(right, { txt: ["v=2", "m=a"] });
    f(right, { txt: ["v=1", "m=a", "v=1"] }); // repeated key
    f(right, { hosts: ["8.8.8.8"] }); // not a LAN address
    f("not-an-instance");
    await sleep(100);
    expect(la.peers()).toEqual([]);
    f(right);
    await until(() => la.peers().length === 1);
    expect(la.peers()[0]).toMatchObject({ deviceId: B, port: 4000 });
  });

  it("refuses to start without an identity", async () => {
    const worker = new MultiWorker();
    const a = await makeClient(worker, "1", dirs);
    await expect(
      a.connect.lan({ ...LOOP, mdns: new MemoryMdnsNetwork().adapter() }),
    ).rejects.toMatchObject({
      reason: "no_identity",
    });
  });

  it("does not dial a device that is not known, or an address off the LAN", async () => {
    const { a, net } = await world();
    const la = await lan(a, net);
    await expect(la.connect(devId("9"))).rejects.toMatchObject({
      reason: "unknown_peer",
    });
    await expect(
      la.connect({ deviceId: B, host: "8.8.8.8", port: 9 }),
    ).rejects.toMatchObject({ reason: "unknown_peer" });
  });
});

describe("LAN admission refusals", () => {
  it("refuses a device of another roster (foreign subject)", async () => {
    const { worker, a, net } = await world();
    const la = await lan(a, net);
    const seen: ConnectSession[] = [];
    la.onSession((s) => seen.push(s));
    worker.subs.set(devId("3"), "ps_BBBBBBBBBBBBBBBBBBBBBB");
    const c = await makeClient(worker, "3", dirs);
    await c.connect.identity();
    const lc = await lan(c, net, { advertise: false, browse: false });
    const err = await lc
      .connect({ deviceId: A, host: "127.0.0.1", port: la.port })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LanError);
    expect((err as LanError).reason).toBe("handshake_failed");
    expect(seen).toEqual([]);
  });

  /** B dials A with its identity altered by `alter`; A must refuse and open no session. */
  async function refused(
    alter: (
      id: Awaited<ReturnType<LanSource["load"]>>,
      w: MultiWorker,
    ) => Promise<Partial<Awaited<ReturnType<LanSource["load"]>>>>,
  ): Promise<void> {
    const { worker, a, b, net } = await world();
    const la = await lan(a, net);
    const seen: ConnectSession[] = [];
    la.onSession((s) => seen.push(s));
    const real = b.connect.lanSource();
    const src: LanSource = {
      ...real,
      load: async () => {
        const id = await real.load();
        return { ...id, ...(await alter(id, worker)) };
      },
    };
    const lb = await LanService.start(src, {
      ...LOOP,
      mdns: net.adapter(),
      advertise: false,
      browse: false,
    });
    services.push(lb);
    await expect(
      lb.connect({ deviceId: A, host: "127.0.0.1", port: la.port }),
    ).rejects.toMatchObject({ reason: "handshake_failed" });
    expect(seen).toEqual([]);
  }

  it("refuses an expired certificate", () =>
    refused(async (_id, worker) => {
      worker.certSpan = -5;
      const certJws = await worker.cert(B, SUB);
      worker.certSpan = 604_800;
      return { certJws, certExpiresAt: T0 - 5 };
    }));

  it("closes silently on a wrong K_disc", () =>
    refused(async () => ({
      keys: { current: new Uint8Array(32).fill(9), previous: null },
    })));
});

/** A raw TCP client; resolves what the listener sent and whether it closed. */
function raw(port: number, host = "127.0.0.1") {
  const got: Buffer[] = [];
  let closed = false;
  const s = tcp({ host, port });
  sockets.push(s);
  s.on("data", (d) => got.push(d));
  s.on("error", () => undefined);
  s.on("close", () => (closed = true));
  return {
    s,
    get closed() {
      return closed;
    },
    get received() {
      return Buffer.concat(got).length;
    },
  };
}

describe("LAN listener bounds", () => {
  it("closes without a word on garbage and on an oversized first frame", async () => {
    const { a, net } = await world();
    const la = await lan(a, net);
    const g = raw(la.port);
    g.s.write(Buffer.concat([Buffer.from([0, 48]), Buffer.alloc(48, 1)]));
    await until(() => g.closed);
    expect(g.received).toBe(0);

    const big = raw(la.port);
    big.s.write(
      Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.alloc(65535, 2)]),
    );
    await until(() => big.closed);
    expect(big.received).toBe(0);

    const zero = raw(la.port);
    zero.s.write(Buffer.from([0, 0]));
    await until(() => zero.closed);
    expect(zero.received).toBe(0);
  });

  it("caps sockets that have not handshaken, per address", async () => {
    const { a, net } = await world();
    const la = await lan(a, net, { maxPendingPerAddress: 2 });
    const socks = [raw(la.port), raw(la.port), raw(la.port), raw(la.port)];
    await until(() => socks.filter((x) => x.closed).length === 2);
    expect(socks.filter((x) => x.closed)).toHaveLength(2);
    expect(socks.every((x) => x.received === 0)).toBe(true);
  });

  it("drops a socket that stalls in the handshake", async () => {
    const { a, net } = await world();
    const la = await lan(a, net, { handshakeMs: 150 });
    const s = raw(la.port);
    await until(() => s.closed, 2000);
    expect(s.received).toBe(0);
  });
});

/** Does this machine have ::1? Tests that need IPv6 loopback skip, with the reason, without it. */
async function hasIpv6Loopback(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "::1", () => probe.close(() => resolve(true)));
  });
}

describe("LAN over IPv6 (one port for both families)", () => {
  it("listens on `::` and takes a session over ::1 and over 127.0.0.1 on the same port", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { a, b, net } = await world();
    // No `host`: the default is the dual-stack `::`, falling back to 0.0.0.0.
    const open = async (c: PolarisKeyClient) => {
      const s = await c.connect.lan({
        mdns: net.adapter(),
        allowLoopback: true,
      });
      services.push(s);
      return s;
    };
    net.hosts = ["::1"];
    const la = await open(a);
    const lb = await open(b);
    const inbound: ConnectSession[] = [];
    la.onSession((s) => inbound.push(s));
    await until(() => lb.peers().some((p) => p.deviceId === A));
    expect(lb.peers()[0]).toMatchObject({
      host: "::1",
      hosts: ["::1"],
      port: la.port,
    });
    const viaV6 = await lb.connect(A);
    await until(() => inbound.length === 1);
    await viaV6.send(utf8("over ::1"));
    expect(text((await inbound[0]!.receive()).body)).toBe("over ::1");
    // The same port answers IPv4.
    const viaV4 = await lb.connect({
      deviceId: A,
      host: "127.0.0.1",
      port: la.port,
    });
    await until(() => inbound.length === 2);
    await viaV4.send(utf8("over 127.0.0.1"));
    expect(text((await inbound[1]!.receive()).body)).toBe("over 127.0.0.1");
  });

  it("dials the next address when the first is not listening", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { a, b, net } = await world();
    // ::1 refuses (A listens on IPv4 only), 127.0.0.1 answers.
    net.hosts = ["::1", "127.0.0.1"];
    const la = await lan(a, net, { host: "127.0.0.1" });
    const lb = await lan(b, net);
    let inn: ConnectSession | null = null;
    la.onSession((s) => (inn = s));
    await until(() => lb.peers().some((p) => p.deviceId === A));
    expect(lb.peers()[0]!.hosts).toEqual(["::1", "127.0.0.1"]);
    const out = await lb.connect(A);
    await until(() => inn !== null);
    expect(out.peerDeviceId).toBe(A);
  });

  it("falls through to the next address when the handshake with the first fails", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { a, b, net } = await world();
    net.hosts = ["::1", "127.0.0.1"];
    const la = await lan(a, net, { host: "127.0.0.1" });
    const lb = await lan(b, net);
    // A neighbour answers first on ::1 at the same port, takes the connection and drops it.
    const decoy = createServer((x) => x.destroy());
    await new Promise<void>((done, fail) => {
      decoy.once("error", fail);
      decoy.listen({ port: la.port, host: "::1" }, () => done());
    });
    try {
      let inn: ConnectSession | null = null;
      la.onSession((x) => (inn = x));
      await until(() => lb.peers().some((p) => p.deviceId === A));
      const out = await lb.connect(A);
      await until(() => inn !== null);
      expect(out.peerDeviceId).toBe(A);
    } finally {
      decoy.close();
    }
  });

  it("fails with the handshake error when every address fails its handshake", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { b, net } = await world();
    const lb = await lan(b, net);
    const decoys = [
      createServer((x) => x.destroy()),
      createServer((x) => x.destroy()),
    ];
    await new Promise<void>((done) =>
      decoys[0]!.listen({ port: 0, host: "::1" }, () => done()),
    );
    const port = (decoys[0]!.address() as { port: number }).port;
    await new Promise<void>((done) =>
      decoys[1]!.listen({ port, host: "127.0.0.1" }, () => done()),
    );
    try {
      const err = await lb
        .connect({
          deviceId: A,
          host: "::1",
          hosts: ["::1", "127.0.0.1"],
          port,
        })
        .catch((e) => e);
      expect(err).toBeInstanceOf(LanError);
      expect(["handshake_failed", "connect_failed"]).toContain(err.reason);
    } finally {
      for (const d of decoys) d.close();
    }
  });

  it("gives the adapter only the names the roster can announce", async () => {
    const { a, b, net } = await world();
    const accepts: ((i: string) => boolean)[] = [];
    const inner = net.adapter();
    const mdns = {
      advertise: inner.advertise,
      browse: async (
        up: Parameters<typeof inner.browse>[0],
        down?: Parameters<typeof inner.browse>[1],
        accept?: (i: string) => boolean,
      ) => {
        if (accept !== undefined) accepts.push(accept);
        return inner.browse(up, down);
      },
    };
    const la = await lan(a, net);
    const lb = await lan(b, net, { mdns });
    expect(accepts).toHaveLength(1);
    const names = [...net.adverts.keys()];
    expect(names).toHaveLength(2);
    // Each advert is one device's; the accept function knows the other device's, not its own.
    const known = names.filter((n) => accepts[0]!(n));
    expect(known).toHaveLength(1);
    expect(accepts[0]!("p1-aaaaaaaaaaaaaaaa")).toBe(false);
    expect(accepts[0]!("laptop")).toBe(false);
    expect(la.port).not.toBe(lb.port);
  });

  it("closes a source off the LAN at once, without reading, and spends no slot on it", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { a, net } = await world();
    // Loopback is not a LAN address unless the host allows it.
    const la = await lan(a, net, { host: "::", allowLoopback: false });
    const socks = [
      raw(la.port, "::1"),
      raw(la.port, "127.0.0.1"),
      raw(la.port, "::1"),
    ];
    for (const x of socks) x.s.write(Buffer.from([0, 48]));
    await until(() => socks.every((x) => x.closed));
    expect(socks.every((x) => x.received === 0)).toBe(true);
  });

  it("holds a loopback source when loopback is allowed, per address", async (ctx) => {
    if (!(await hasIpv6Loopback())) return ctx.skip("no ::1 on this machine");
    const { a, net } = await world();
    const la = await lan(a, net, { host: "::", maxPendingPerAddress: 2 });
    const socks = [
      raw(la.port, "::1"),
      raw(la.port, "::1"),
      raw(la.port, "::1"),
    ];
    await until(() => socks.filter((x) => x.closed).length === 1);
    // The same peer over IPv4 is another address and keeps its own count.
    const v4 = raw(la.port, "127.0.0.1");
    await sleep(100);
    expect(v4.closed).toBe(false);
  });
});

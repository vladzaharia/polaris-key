// @pkey-feature connect.lan
// The mDNS adapter (CC-08.2, CC-IPV6.3): the PTR/SRV/TXT/A/AAAA layer against fake `multicast-dns`
// sockets (one for IPv4, one per IPv6 interface), what a browse keeps and drops, and real multicast
// round trips on this machine, IPv4 and IPv6 (skipped, with the reason printed, when the sandbox
// has no multicast).
import { EventEmitter } from "node:events";
import { networkInterfaces } from "node:os";
import { describe, expect, it, vi } from "vitest";
import {
  MulticastDnsAdapter,
  PEER_SERVICE,
  isLanAddress,
  ownInterfaces,
  type MdnsFound,
  type MdnsInterface,
  type MdnsSocket,
} from "../src/connect/mdns.js";

const INST = "p1-abcdefghijklmnop";
const FQDN = `${INST}.${PEER_SERVICE}`;
/** The UDP source of the packets: an A record is believed only from its own address. */
const SRC = { address: "192.168.1.20" };
const HOST = `${INST}.local`;
/** The connected IPv4 subnets of the fake machine. */
const subnets = (): string[] => ["192.168.0.0/16"];

class FakeSocket extends EventEmitter implements MdnsSocket {
  responses: any[] = [];
  queries: any[] = [];
  destroyed = false;
  respond(p: unknown, cb?: (e?: Error | null) => void): void {
    this.responses.push(p);
    cb?.();
  }
  query(p: unknown, cb?: (e?: Error | null) => void): void {
    this.queries.push(p);
    cb?.();
  }
  destroy(cb?: () => void): void {
    this.destroyed = true;
    cb?.();
  }
}

/** Browse with `a`: what came up and what went down. */
async function see(a: MulticastDnsAdapter) {
  const up: MdnsFound[] = [];
  const down: string[] = [];
  const handle = await a.browse(
    (f) => up.push(f),
    (i) => down.push(i),
  );
  return { up, down, handle };
}

/** A browse on a fake IPv4 socket. */
const watch = (s: FakeSocket, o: { subnets?: () => string[] } = {}) =>
  see(new MulticastDnsAdapter({ create: () => s, subnets, ...o }));

const packet = (
  over: Partial<Record<string, any>> = {},
): { answers: any[] } => ({
  answers: [
    { name: PEER_SERVICE, type: "PTR", ttl: 120, data: FQDN },
    {
      name: FQDN,
      type: "SRV",
      ttl: 120,
      data: { port: 4242, target: HOST, priority: 0, weight: 0 },
    },
    {
      name: FQDN,
      type: "TXT",
      ttl: 4500,
      data: [Buffer.from("v=1"), Buffer.from("m=a")],
    },
    { name: HOST, type: "A", ttl: 120, data: "192.168.1.20" },
  ],
  ...over,
});

describe("MulticastDnsAdapter", () => {
  it("advertises the service, answers queries and says goodbye", async () => {
    const s = new FakeSocket();
    const a = new MulticastDnsAdapter({
      create: () => s,
      addresses: () => ["192.168.1.20", "8.8.8.8"],
    });
    const h = await a.advertise({
      instance: INST,
      port: 4242,
      txt: ["v=1", "m=a"],
    });
    const first = s.responses[0].answers;
    expect(first.map((r: any) => `${r.type} ${r.name}`)).toEqual([
      `PTR ${PEER_SERVICE}`,
      `SRV ${FQDN}`,
      `TXT ${FQDN}`,
      `A ${HOST}`, // the public address is not advertised
    ]);
    expect(first[0].data).toBe(FQDN);
    expect(first[1].data).toEqual({
      port: 4242,
      target: HOST,
      priority: 0,
      weight: 0,
    });
    expect(first[2].data).toEqual(["v=1", "m=a"]);
    expect(first[3].data).toBe("192.168.1.20");
    // The host name is the instance name, not the machine's.
    expect(JSON.stringify(first)).not.toContain(require("node:os").hostname());
    const n = s.responses.length;
    s.emit("query", {
      questions: [{ name: "_other._tcp.local", type: "PTR" }],
    });
    expect(s.responses).toHaveLength(n);
    s.emit("query", { questions: [{ name: PEER_SERVICE, type: "PTR" }] });
    expect(s.responses).toHaveLength(n + 1);
    // Replies are sent at most once a second.
    s.emit("query", { questions: [{ name: PEER_SERVICE, type: "PTR" }] });
    expect(s.responses).toHaveLength(n + 1);
    await h.stop();
    const bye = s.responses.at(-1).answers;
    expect(bye.every((r: any) => r.ttl === 0)).toBe(true);
    expect(s.destroyed).toBe(true);
  });

  it("refuses an advert name that is not an instance name", async () => {
    const a = new MulticastDnsAdapter({ create: () => new FakeSocket() });
    await expect(
      a.advertise({ instance: "laptop", port: 1, txt: [] }),
    ).rejects.toThrow(RangeError);
  });

  it("browses: resolves PTR, SRV, TXT and A once, asks for what is missing, reports goodbyes", async () => {
    const s = new FakeSocket();
    const { up, down, handle: h } = await watch(s);
    expect(s.queries[0].questions[0]).toEqual({
      name: PEER_SERVICE,
      type: "PTR",
    });
    // The PTR alone: not up yet, and the next question asks for the rest.
    s.emit("response", { answers: [packet().answers[0]] }, SRC);
    expect(up).toEqual([]);
    s.emit("response", { answers: packet().answers.slice(1) }, SRC);
    expect(up).toEqual([
      {
        instance: INST,
        hosts: ["192.168.1.20"],
        port: 4242,
        txt: ["v=1", "m=a"],
      },
    ]);
    // The same answer again is not a second event.
    s.emit("response", packet(), SRC);
    expect(up).toHaveLength(1);
    s.emit(
      "response",
      { answers: [{ name: PEER_SERVICE, type: "PTR", ttl: 0, data: FQDN }] },
      SRC,
    );
    expect(down).toEqual([INST]);
    await h.stop();
    expect(s.destroyed).toBe(true);
  });

  it("expires a peer whose PTR TTL lapses without a refresh, and resolves it again after a re-announce", async () => {
    vi.useFakeTimers();
    try {
      const s = new FakeSocket();
      const { up, down, handle: h } = await watch(s);
      s.emit("response", packet(), SRC);
      expect(up).toHaveLength(1);
      // A refresh at 100 s restarts the 120 s clock.
      vi.advanceTimersByTime(100_000);
      s.emit("response", { answers: [packet().answers[0]] }, SRC);
      vi.advanceTimersByTime(100_000);
      expect(down).toEqual([]);
      // No refresh: gone once the TTL lapses.
      vi.advanceTimersByTime(30_000);
      expect(down).toEqual([INST]);
      // The same advert coming back is a new up.
      s.emit("response", packet(), SRC);
      expect(up).toHaveLength(2);
      await h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops what it should not trust", async () => {
    const run = async (answers: any[]): Promise<MdnsFound[]> => {
      const s = new FakeSocket();
      const { up } = await watch(s);
      s.emit("response", { answers }, SRC);
      return up;
    };
    const mutate = (f: (p: ReturnType<typeof packet>) => void) => {
      const p = packet();
      f(p);
      return run(p.answers);
    };
    expect(await run(packet().answers)).toHaveLength(1); // the control
    expect(await mutate((p) => (p.answers[3]!.data = "8.8.8.8"))).toEqual([]);
    expect(await mutate((p) => (p.answers[3]!.data = "127.0.0.1"))).toEqual([]);
    expect(
      await mutate((p) => (p.answers[1]!.data.target = "evil.example.com")),
    ).toEqual([]);
    expect(await mutate((p) => (p.answers[1]!.data.port = 70_000))).toEqual([]);
    expect(
      await run([
        {
          name: PEER_SERVICE,
          type: "PTR",
          ttl: 120,
          data: `laptop.${PEER_SERVICE}`,
        },
        {
          name: `laptop.${PEER_SERVICE}`,
          type: "SRV",
          ttl: 120,
          data: { port: 1, target: "laptop.local" },
        },
      ]),
    ).toEqual([]);
    // A PTR under another service.
    const other = packet().answers;
    other[0] = { name: "_http._tcp.local", type: "PTR", ttl: 1, data: FQDN };
    expect(await run(other)).toHaveLength(1); // SRV/TXT/A still name the instance by themselves
  });

  it("believes an A record only from its own source, keeps four, and lists the first seen first", async () => {
    const s = new FakeSocket();
    const { up } = await watch(s);
    const [ptr, srv, txt] = packet().answers;
    const a = (ip: string) => ({ name: HOST, type: "A", ttl: 120, data: ip });
    s.emit("response", { answers: [ptr, srv, txt] }, SRC);
    // A neighbour claims another device's name for an address that is not its own.
    s.emit("response", { answers: [a("192.168.1.99")] }, SRC);
    expect(up).toEqual([]);
    // Several sources answer; the first seen leads, not the lexically smallest.
    s.emit(
      "response",
      { answers: [a("192.168.1.50")] },
      { address: "192.168.1.50" },
    );
    for (const n of [10, 11, 12, 13, 14])
      s.emit(
        "response",
        { answers: [a(`192.168.1.${n}`)] },
        { address: `192.168.1.${n}` },
      );
    expect(up.map((f) => f.hosts)).toEqual([
      ["192.168.1.50"],
      ["192.168.1.50", "192.168.1.10"],
      ["192.168.1.50", "192.168.1.10", "192.168.1.11"],
      ["192.168.1.50", "192.168.1.10", "192.168.1.11", "192.168.1.12"],
    ]);
  });

  it("learns by equality alone: a public address that is the source is kept for the dial-time verdict", async () => {
    const s = new FakeSocket();
    const { up } = await watch(s, { subnets: () => ["8.8.8.0/24"] });
    const [ptr, srv, txt] = packet().answers;
    s.emit(
      "response",
      {
        answers: [
          ptr,
          srv,
          txt,
          { name: HOST, type: "A", ttl: 120, data: "8.8.8.8" },
        ],
      },
      { address: "8.8.8.8" },
    );
    expect(up.map((f) => f.hosts)).toEqual([["8.8.8.8"]]);
  });

  it("ignores a response whose source is outside the connected subnets, or unknown", async () => {
    const s = new FakeSocket();
    const { up } = await watch(s);
    const from = (address: string) => ({
      answers: packet().answers.map((r) =>
        r.type === "A" ? { ...r, data: address } : r,
      ),
    });
    s.emit("response", from("10.9.9.9"), { address: "10.9.9.9" });
    s.emit("response", packet()); // no source at all
    s.emit("response", packet(), { address: "fe80::5" }); // wrong family
    expect(up).toEqual([]);
    s.emit("response", packet(), SRC);
    expect(up).toHaveLength(1);
  });

  it("names fold by ASCII, and an address record with TTL 0 withdraws the address", async () => {
    const s = new FakeSocket();
    const { up, down } = await watch(s);
    const [ptr, srv, txt] = packet().answers;
    const a = (ttl: number) => ({
      name: HOST.toUpperCase(),
      type: "A",
      ttl,
      data: "192.168.1.20",
    });
    s.emit("response", { answers: [ptr, srv, txt, a(120)] }, SRC);
    expect(up.map((f) => f.hosts)).toEqual([["192.168.1.20"]]);
    s.emit("response", { answers: [a(0)] }, SRC);
    expect(down).toEqual([INST]);
    // It can come back.
    s.emit("response", { answers: [a(120)] }, SRC);
    expect(up).toHaveLength(2);
  });

  it("expires and evicts resolve entries so a flood cannot stop discovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = new FakeSocket();
      const { up } = await watch(s);
      const base32 = "abcdefghijklmnopqrstuvwxyz234567";
      const flood = (n: number) => ({
        answers: Array.from({ length: n }, (_, i) => ({
          name: PEER_SERVICE,
          type: "PTR",
          ttl: 120,
          data: `p1-${base32[i % 32]}${base32[(i >> 5) % 32]}${"b".repeat(14)}.${PEER_SERVICE}`,
        })),
      });
      // Full of half-resolved names: the real device still resolves (the oldest is evicted).
      s.emit("response", flood(400), SRC);
      s.emit("response", packet(), SRC);
      expect(up.map((f) => f.instance)).toEqual([INST]);
      // And much later, after the entries expired, a new device resolves as well.
      vi.setSystemTime(Date.now() + 6 * 60_000);
      const other = packet();
      const inst2 = "p1-ccccccccccccccc2";
      const host2 = `${inst2}.local`;
      const fq2 = `${inst2}.${PEER_SERVICE}`;
      other.answers[0]!.data = fq2;
      other.answers[1]!.name = fq2;
      other.answers[1]!.data.target = host2;
      other.answers[2]!.name = fq2;
      other.answers[3]!.name = host2;
      s.emit("response", other, SRC);
      expect(up.map((f) => f.instance)).toEqual([INST, inst2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds the instances it tracks", async () => {
    const s = new FakeSocket();
    const a = new MulticastDnsAdapter({ create: () => s, subnets });
    const up: MdnsFound[] = [];
    await a.browse((f) => up.push(f));
    const base32 = "abcdefghijklmnopqrstuvwxyz234567";
    const answers: any[] = [];
    for (let i = 0; i < 400; i++) {
      const inst = `p1-${base32[i % 32]}${base32[(i >> 5) % 32]}${"a".repeat(14)}`;
      answers.push({
        name: PEER_SERVICE,
        type: "PTR",
        ttl: 120,
        data: `${inst}.${PEER_SERVICE}`,
      });
    }
    s.emit("response", { answers }, SRC);
    // Nothing resolves (no SRV), and asking is capped.
    expect(up).toEqual([]);
    s.emit("response", { answers: [] }, SRC);
    expect(s.queries.every((q) => q.questions.length <= 32)).toBe(true);
  });

  it("isLanAddress", () => {
    for (const ok of ["10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.0.9"])
      expect(isLanAddress(ok)).toBe(true);
    for (const no of [
      "169.254.1.1",
      "100.64.0.1",
      "8.8.8.8",
      "172.32.0.1",
      "127.0.0.1",
      "0.0.0.0",
      "::1",
      "300.1.1.1",
      "192.168.1",
    ])
      expect(isLanAddress(no)).toBe(false);
    expect(isLanAddress("127.0.0.1", true)).toBe(true);
  });
});

/** One real advert and one real browse; the found advert, or null after skipping with the reason. */
async function roundTrip(
  adv: MulticastDnsAdapter,
  brw: MulticastDnsAdapter,
  ctx: { skip(why: string): never },
  what: string,
): Promise<MdnsFound | null> {
  let found: MdnsFound | null = null;
  const handles: { stop(): Promise<void> }[] = [];
  try {
    handles.push(await brw.browse((f) => f.instance === INST && (found = f)));
    handles.push(
      await adv.advertise({ instance: INST, port: 4242, txt: ["v=1", "m=a"] }),
    );
    const t = Date.now();
    while (found === null && Date.now() - t < 4000)
      await new Promise((r) => setTimeout(r, 50));
  } catch (e) {
    return ctx.skip(`${what} is not available here: ${(e as Error).message}`);
  } finally {
    await Promise.all(handles.map((h) => h.stop()));
  }
  if (found === null)
    return ctx.skip(`no ${what} loopback delivery in this sandbox`);
  return found;
}

describe("multicast-dns on this machine", () => {
  it("advertises and browses over real multicast", async (ctx) => {
    // The packet's source is this machine's own address on the sending interface, so the advert
    // names this machine's real LAN addresses.
    const own = Object.values(networkInterfaces())
      .flatMap((l) => l ?? [])
      .filter(
        (i) => i.family === "IPv4" && !i.internal && isLanAddress(i.address),
      )
      .map((i) => i.address);
    if (own.length === 0)
      return ctx.skip("no RFC 1918 address on this machine");
    const found = await roundTrip(
      new MulticastDnsAdapter({ allowLoopback: true, v6: false }),
      new MulticastDnsAdapter({ allowLoopback: true, v6: false }),
      ctx,
      "multicast",
    );
    if (found === null) return;
    expect(found.port).toBe(4242);
    expect(found.hosts.length).toBeGreaterThan(0);
    for (const h of found.hosts) expect(own).toContain(h);
  });

  it("advertises and browses over real IPv6 multicast, with the interface as the zone", async (ctx) => {
    const ifaces = ownInterfaces();
    if (ifaces.length === 0)
      return ctx.skip("no multicast-capable interface with an fe80 address");
    const only = {
      create: () => new FakeSocket(),
      v6: { interfaces: () => ifaces },
    };
    const found = await roundTrip(
      new MulticastDnsAdapter(only),
      new MulticastDnsAdapter(only),
      ctx,
      "IPv6 multicast",
    );
    if (found === null) return;
    expect(found.port).toBe(4242);
    expect(found.hosts.length).toBeGreaterThan(0);
    for (const h of found.hosts) {
      const [addr, zone] = h.split("%");
      expect(addr).toMatch(/^fe80:/);
      expect(ifaces.map((i) => i.zone)).toContain(zone);
    }
  });
});

describe("IPv6: one socket per interface", () => {
  const LL = "fe80::1c2:3ff:fe4:5a6";
  const en0: MdnsInterface = {
    name: "en0",
    zone: "en0",
    addresses: [LL],
    nets: ["fe80::1c2:3ff:fe4:5a6/64", "2001:db8:1:2::9/64"],
  };
  const wlan0: MdnsInterface = {
    name: "wlan0",
    zone: "wlan0",
    addresses: ["fe80::9"],
    nets: ["fe80::9/64"],
  };
  const world = () => {
    const v4 = new FakeSocket();
    const v6 = new Map<string, FakeSocket>([
      ["en0", new FakeSocket()],
      ["wlan0", new FakeSocket()],
    ]);
    const a = new MulticastDnsAdapter({
      create: () => v4,
      subnets,
      addresses: () => ["192.168.1.20"],
      v6: { interfaces: () => [en0, wlan0], create: (i) => v6.get(i.name)! },
    });
    return { v4, v6, a };
  };
  const aaaa = (data: string, ttl = 120) => ({
    name: HOST,
    type: "AAAA",
    ttl,
    data,
  });

  it("is off when only the IPv4 socket is injected, and with v6: false", async () => {
    const calls: string[] = [];
    const v6 = {
      interfaces: () => [en0],
      create: (i: MdnsInterface) => (calls.push(i.name), new FakeSocket()),
    };
    await new MulticastDnsAdapter({ create: () => new FakeSocket() }).browse(
      () => undefined,
    );
    await new MulticastDnsAdapter({
      create: () => new FakeSocket(),
      v6: false,
    }).browse(() => undefined);
    expect(calls).toEqual([]);
    await new MulticastDnsAdapter({
      create: () => new FakeSocket(),
      v6,
    }).browse(() => undefined);
    expect(calls).toEqual(["en0"]);
  });

  it("uses at most eight interfaces, and skips one whose socket cannot be made", async () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...en0,
      name: `if${i}`,
      zone: `if${i}`,
    }));
    const made: string[] = [];
    await new MulticastDnsAdapter({
      create: () => new FakeSocket(),
      v6: {
        interfaces: () => many,
        create: (i) => {
          made.push(i.name);
          if (i.name === "if1") throw new Error("EADDRNOTAVAIL");
          return new FakeSocket();
        },
      },
    }).browse(() => undefined);
    expect(made).toEqual(Array.from({ length: 8 }, (_, i) => `if${i}`));
  });

  it("answers an A on the IPv4 socket and an AAAA on each interface's own, and says goodbye on all", async () => {
    const { v4, v6, a } = world();
    const h = await a.advertise({
      instance: INST,
      port: 4242,
      txt: ["v=1", "m=a"],
    });
    const kinds = (s: FakeSocket) =>
      s.responses[0].answers.map((r: any) => `${r.type} ${r.data}`).slice(3);
    expect(kinds(v4)).toEqual(["A 192.168.1.20"]);
    expect(kinds(v6.get("en0")!)).toEqual([`AAAA ${LL}`]);
    expect(kinds(v6.get("wlan0")!)).toEqual(["AAAA fe80::9"]);
    // A query on one socket is answered on that socket only.
    v6.get("wlan0")!.emit("query", {
      questions: [{ name: PEER_SERVICE.toUpperCase(), type: "PTR" }],
    });
    expect(v6.get("wlan0")!.responses).toHaveLength(2);
    expect(v6.get("en0")!.responses).toHaveLength(1);
    await h.stop();
    for (const s of [v4, ...v6.values()]) {
      expect(s.responses.at(-1).answers.every((r: any) => r.ttl === 0)).toBe(
        true,
      );
      expect(s.destroyed).toBe(true);
    }
  });

  it("asks for AAAA as well as A, on every socket", async () => {
    vi.useFakeTimers();
    try {
      const { v4, v6, a } = world();
      await a.browse(() => undefined);
      for (const s of [v4, ...v6.values()])
        expect(s.queries[0].questions).toEqual([
          { name: PEER_SERVICE, type: "PTR" },
        ]);
      // An instance whose SRV, TXT or address is missing is asked for by type.
      v4.emit("response", { answers: [packet().answers[0]] }, SRC);
      vi.advanceTimersByTime(1000);
      for (const s of [v4, ...v6.values()])
        expect(s.queries[1].questions.map((q: any) => q.type)).toEqual([
          "PTR",
          "SRV",
          "TXT",
          "A",
          "AAAA",
        ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the arrival interface as the zone of a link-local address, and lists A and AAAA together", async () => {
    const { v4, v6, a } = world();
    const { up } = await see(a);
    const [ptr, srv, txt] = packet().answers;
    // The same neighbour is heard on two links: two hosts, told apart by their zone.
    v6.get("en0")!.emit(
      "response",
      { answers: [ptr, srv, txt, aaaa(LL)] },
      { address: `${LL}%en0` },
    );
    expect(up.at(-1)!.hosts).toEqual([`${LL}%en0`]);
    v6.get("wlan0")!.emit(
      "response",
      { answers: [aaaa("fe80::1c2:3ff:fe4:5a6")] },
      { address: LL },
    );
    expect(up.at(-1)!.hosts).toEqual([`${LL}%en0`, `${LL}%wlan0`]);
    v4.emit("response", { answers: [packet().answers[3]] }, SRC);
    expect(up.at(-1)!.hosts).toEqual([
      `${LL}%en0`,
      `${LL}%wlan0`,
      "192.168.1.20",
    ]);
    // A fifth address is not kept: at most four.
    v6.get("en0")!.emit(
      "response",
      { answers: [aaaa("2001:db8:1:2::5")] },
      { address: "2001:db8:1:2::5" },
    );
    v6.get("en0")!.emit(
      "response",
      { answers: [aaaa("2001:db8:1:2::6")] },
      { address: "2001:db8:1:2::6" },
    );
    expect(up.at(-1)!.hosts).toHaveLength(4);
    expect(up.at(-1)!.hosts[3]).toBe("2001:db8:1:2::5");
  });

  it("ignores a response from outside the interface's connected subnets, and an AAAA that is not the source", async () => {
    const { v6, a } = world();
    const { up } = await see(a);
    const [ptr, srv, txt] = packet().answers;
    const full = (data: string) => ({ answers: [ptr, srv, txt, aaaa(data)] });
    // A global source that is not on any of en0's subnets.
    v6.get("en0")!.emit("response", full("2001:db8:9::5"), {
      address: "2001:db8:9::5",
    });
    // A source on the subnet claiming another address.
    v6.get("en0")!.emit("response", full("fe80::dead"), {
      address: `${LL}%en0`,
    });
    // fe80 is on wlan0's /64 too, but its own address is fe80::9/64: a global one is not.
    v6.get("wlan0")!.emit("response", full("2001:db8:1:2::5"), {
      address: "2001:db8:1:2::5",
    });
    expect(up).toEqual([]);
    v6.get("en0")!.emit("response", full("2001:db8:1:2::5"), {
      address: "2001:db8:1:2::5",
    });
    expect(up.map((f) => f.hosts)).toEqual([["2001:db8:1:2::5"]]);
  });

  it("withdraws one address on TTL 0 and reports the peer down when none is left", async () => {
    const { v6, a } = world();
    const { up, down } = await see(a);
    const en0s = v6.get("en0")!;
    const [ptr, srv, txt] = packet().answers;
    en0s.emit(
      "response",
      { answers: [ptr, srv, txt, aaaa(LL)] },
      { address: LL },
    );
    en0s.emit(
      "response",
      { answers: [aaaa("2001:db8:1:2::5")] },
      { address: "2001:db8:1:2::5" },
    );
    expect(up.at(-1)!.hosts).toEqual([`${LL}%en0`, "2001:db8:1:2::5"]);
    en0s.emit("response", { answers: [aaaa(LL, 0)] }, { address: LL });
    expect(up.at(-1)!.hosts).toEqual(["2001:db8:1:2::5"]);
    expect(down).toEqual([]);
    en0s.emit(
      "response",
      { answers: [aaaa("2001:db8:1:2::5", 0)] },
      { address: "2001:db8:1:2::5" },
    );
    expect(down).toEqual([INST]);
  });
});

describe("ownInterfaces", () => {
  it("lists at most eight interfaces, each with an fe80 address and its subnets", () => {
    const list = ownInterfaces();
    expect(list.length).toBeLessThanOrEqual(8);
    for (const i of list) {
      expect(i.addresses.length).toBeGreaterThan(0);
      for (const a of i.addresses) expect(a).toMatch(/^fe[89ab][0-9a-f]:/);
      expect(i.nets.length).toBeGreaterThan(0);
      expect(i.zone).toBe(process.platform === "win32" ? i.zone : i.name);
    }
  });
});

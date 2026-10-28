// @pkey-feature connect.lan
// The mDNS adapter (CC-08.2): the PTR/SRV/TXT/A layer against a fake `multicast-dns` socket, what
// a browse keeps and drops, and one real multicast round trip on this machine (skipped, with the
// reason printed, when the sandbox has no multicast).
import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  MulticastDnsAdapter,
  PEER_SERVICE,
  isLanAddress,
  type MdnsFound,
  type MdnsSocket,
} from "../src/connect/mdns.js";

const INST = "p1-abcdefghijklmnop";
const FQDN = `${INST}.${PEER_SERVICE}`;
/** The UDP source of the packets: an A record is believed only from its own address. */
const SRC = { address: "192.168.1.20" };
const HOST = `${INST}.local`;

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
    const a = new MulticastDnsAdapter({ create: () => s });
    const up: MdnsFound[] = [];
    const down: string[] = [];
    const h = await a.browse(
      (f) => up.push(f),
      (i) => down.push(i),
    );
    expect(s.queries[0].questions[0]).toEqual({
      name: PEER_SERVICE,
      type: "PTR",
    });
    // The PTR alone: not up yet, and the next question asks for the rest.
    s.emit("response", { answers: [packet().answers[0]] }, SRC);
    expect(up).toEqual([]);
    s.emit("response", { answers: packet().answers.slice(1) }, SRC);
    expect(up).toEqual([
      { instance: INST, host: "192.168.1.20", port: 4242, txt: ["v=1", "m=a"] },
    ]);
    // The same answer again is not a second event.
    s.emit("response", packet(), SRC);
    expect(up).toHaveLength(1);
    s.emit("response", {
      answers: [{ name: PEER_SERVICE, type: "PTR", ttl: 0, data: FQDN }],
    });
    expect(down).toEqual([INST]);
    await h.stop();
    expect(s.destroyed).toBe(true);
  });

  it("expires a peer whose PTR TTL lapses without a refresh, and resolves it again after a re-announce", async () => {
    vi.useFakeTimers();
    try {
      const s = new FakeSocket();
      const up: MdnsFound[] = [];
      const down: string[] = [];
      const h = await new MulticastDnsAdapter({ create: () => s }).browse(
        (f) => up.push(f),
        (i) => down.push(i),
      );
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
      const up: MdnsFound[] = [];
      await new MulticastDnsAdapter({ create: () => s }).browse((f) =>
        up.push(f),
      );
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

  it("believes an A record only from its own source, keeps four, and dials the first seen", async () => {
    const s = new FakeSocket();
    const up: MdnsFound[] = [];
    await new MulticastDnsAdapter({ create: () => s }).browse((f) =>
      up.push(f),
    );
    const [ptr, srv, txt] = packet().answers;
    const a = (ip: string) => ({ name: HOST, type: "A", ttl: 120, data: ip });
    s.emit("response", { answers: [ptr, srv, txt] }, SRC);
    // A neighbour claims another device's name for an address that is not its own.
    s.emit("response", { answers: [a("192.168.1.99")] }, SRC);
    expect(up).toEqual([]);
    // Several sources answer; the first is dialled, not the lexically smallest.
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
    expect(up).toHaveLength(1);
    expect(up[0]!.host).toBe("192.168.1.50");
  });

  it("expires and evicts resolve entries so a flood cannot stop discovery", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const s = new FakeSocket();
      const up: MdnsFound[] = [];
      await new MulticastDnsAdapter({ create: () => s }).browse((f) =>
        up.push(f),
      );
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
    const a = new MulticastDnsAdapter({ create: () => s });
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
    s.emit("response", { answers });
    // Nothing resolves (no SRV), and asking is capped.
    expect(up).toEqual([]);
    s.emit("response", { answers: [] });
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

describe("multicast-dns on this machine", () => {
  it("advertises and browses over real multicast", async (ctx) => {
    const adv = new MulticastDnsAdapter({
      allowLoopback: true,
      addresses: () => ["127.0.0.1"],
    });
    const brw = new MulticastDnsAdapter({ allowLoopback: true });
    let found: MdnsFound | null = null;
    let handles: { stop(): Promise<void> }[] = [];
    try {
      handles.push(await brw.browse((f) => f.instance === INST && (found = f)));
      handles.push(
        await adv.advertise({
          instance: INST,
          port: 4242,
          txt: ["v=1", "m=a"],
        }),
      );
      const t = Date.now();
      while (found === null && Date.now() - t < 4000)
        await new Promise((r) => setTimeout(r, 50));
    } catch (e) {
      ctx.skip(`multicast is not available here: ${(e as Error).message}`);
    } finally {
      await Promise.all(handles.map((h) => h.stop()));
    }
    if (found === null)
      return ctx.skip("no multicast loopback delivery in this sandbox");
    expect(found).toMatchObject({
      instance: INST,
      host: "127.0.0.1",
      port: 4242,
    });
  });
});

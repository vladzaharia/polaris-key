// @pkey-feature connect.relay connect.lan connect.app
// The R-6 fix round for the Node transport (CC-08.2 and CC-08.3): what a hostile or broken peer,
// room or neighbour can cost. Each block pins one finding.
import { EventEmitter } from "node:events";
import type { Socket } from "node:net";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { PeerDocs, type ConnectNotice } from "../src/connect/channel.js";
import {
  QUEUE_MAX_BYTES,
  QUEUE_PAUSE_BYTES,
  ConnectSession,
} from "../src/connect/index.js";
import {
  DIAL_MAX_IN_FLIGHT,
  DIAL_STAGGER_MS,
  dialRace,
} from "../src/connect/dial.js";
import type { LanSource } from "../src/connect/lan.js";
import {
  PendingLimiter,
  limiterKeys,
  socketVerdict,
  textVerdict,
} from "../src/connect/lanJudge.js";
import {
  MemoryMdnsNetwork,
  T0,
  devId,
  loopLan,
  makeClient,
  sleep,
  until,
} from "./lanFixtures.js";
import { ManualTimer, relayHarness } from "./relayFixtures.js";

const A = devId("1");
const { dirs, clients, world, svc } = relayHarness();

describe("finding 3: nothing prints the discovery key", () => {
  it("a live LAN session and the services, at depth 12", async () => {
    const { a, b, worker, room } = await world();
    const net = new MemoryMdnsNetwork();
    const lan = loopLan(net);
    await a.cloudConnect.start({ lan, relay: { webSocket: room.webSocket } });
    await b.cloudConnect.start({ lan, relay: { webSocket: room.webSocket } });
    await until(() => a.cloudConnect.peers().some((p) => p.lan));
    const viaLan = await a.cloudConnect.open(devId("2"));
    const secret = worker.disc;
    const views = [viaLan, a.cloudConnect, a.connect, b.cloudConnect].map(
      (v) => inspect(v, { depth: 12, showHidden: true }) + JSON.stringify(v),
    );
    for (const v of views) expect(v).not.toContain(secret);
    expect(viaLan.path).toBe("lan");
  });

  it("a relay session and a relay service", async () => {
    const { a, b, worker, room } = await world();
    const relay = { webSocket: room.webSocket };
    await a.cloudConnect.start({ lan: false, relay });
    await b.cloudConnect.start({ lan: false, relay });
    await until(() => b.cloudConnect.peers().some((p) => p.deviceId === A));
    const s = await b.cloudConnect.open(A);
    expect(s.path).toBe("relay");
    const r = svc(a, room, new ManualTimer());
    for (const v of [s, r])
      for (const view of [
        inspect(v, { depth: 12, showHidden: true }),
        JSON.stringify(v),
      ])
        expect(view).not.toContain(worker.disc);
  });
});

describe("finding 4: backoff resets only after a stable open", () => {
  it("an accept-then-close loop keeps growing, and never goes under the floor", async () => {
    const { a, room, worker } = await world();
    const t = new ManualTimer();
    const r = svc(a, room, t, { backoffMinMs: 700 });
    await r.ready();
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = t.delays.length;
      room.dropAll(1006);
      await until(() => r.status.state === "backoff");
      const d = t.delays
        .slice(before)
        .find((x) => x >= 700 && x <= 60_000 && x !== 25_000)!;
      delays.push(d);
      expect(t.fire((ms) => ms === d)).toBe(true);
      await r.ready();
    }
    // 1 s then 2 s then 4 s caps, half fixed and half jitter at 0.5.
    expect(delays).toEqual([750, 1500, 3000]);
    expect(worker.ticketsAsked).toBe(4);
    expect(r.status.attempts).toBe(3);
  });

  it("a socket that stayed open resets it", async () => {
    const { a, room } = await world();
    const t = new ManualTimer();
    const r = svc(a, room, t, { stableMs: 0 });
    await r.ready();
    room.dropAll(1006);
    await until(() => r.status.state === "backoff");
    expect(r.status.attempts).toBe(1);
    expect(t.fire((ms) => ms === 750)).toBe(true);
    await r.ready();
    room.dropAll(1006);
    await until(() => r.status.state === "backoff");
    expect(r.status.attempts).toBe(1);
  });
});

describe("finding 5: Retry-After is capped", () => {
  it("waits at most an hour, however large the header", async () => {
    const { a, room, worker } = await world();
    worker.relay = "paused";
    worker.retryAfter = 99_999_999_999;
    const t = new ManualTimer();
    const r = svc(a, room, t);
    await until(() => r.status.state === "backoff");
    expect(t.delays).toContain(3_600_000);
    expect(Math.max(...t.delays.filter((d) => d !== 25_000))).toBe(3_600_000);
  });
});

describe("finding 6: a pushed roster that removed a device", () => {
  it("marks K_disc stale until an identity fetch brings the new one", async () => {
    const { a, b, worker } = await world();
    const c = await makeClient(worker, "3", dirs);
    clients.push(c);
    await c.connect.identity();
    await a.connect.identity({ refresh: true });
    await b.connect.identity({ refresh: true });
    expect(await a.connect.discoveryKeys()).not.toBeNull();
    // The third device leaves; the roster at the new epoch is pushed to A.
    worker.members.delete(devId("3"));
    worker.epoch++;
    const sub = (await a.connect.current())!.sub;
    const ring = await worker.ring(sub);
    expect(await a.connect.adoptRing(ring)).toMatchObject({ stored: true });
    expect(await a.connect.discoveryKeys()).toBeNull();
    await a.connect.identity();
    expect(await a.connect.discoveryKeys()).not.toBeNull();
  });

  it("tries the fetch again at the end of the rate-limit gap, and again after a failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0 * 1000);
    let now = T0;
    let refreshes = 0;
    let fail = true;
    const src = {
      now: () => now,
      refresh: async () => {
        refreshes++;
        if (fail) throw new Error("offline");
      },
      adoptRing: async () => ({ stored: true as const, epoch: 2 }),
    } as unknown as LanSource;
    const docs = new PeerDocs(src, () => undefined);
    expect(docs.wantRing()).toBe(true); // a peer asked: this takes the minute's slot
    await vi.advanceTimersByTimeAsync(0);
    docs.ring("jws-1"); // stored, but the slot is taken
    await vi.advanceTimersByTimeAsync(0);
    expect(refreshes).toBe(1);
    now += 61;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refreshes).toBe(2); // the deferred try; it fails
    now += 61;
    fail = false;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(refreshes).toBe(3); // and the failure is retried
    docs.close();
  });
});

describe("finding 7: floods from an authenticated peer", () => {
  it("bounds the pushed documents waiting, and refuses a repeat", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const src = {
      now: () => T0,
      adoptRing: async () => {
        await gate;
        return { stored: false as const, reason: "epoch-not-higher" };
      },
    } as unknown as LanSource;
    const docs = new PeerDocs(src, () => undefined);
    const notes: ConnectNotice[] = [];
    docs.onNotice((n) => notes.push(n));
    for (let i = 0; i < 50; i++) docs.ring(`ring-${i % 20}`);
    const busy = notes.filter(
      (n) => n.outcome === "refused" && "reason" in n && n.reason === "busy",
    );
    // Eight wait; the rest (new ones over the cap, and repeats of waiting ones) are refused at once.
    expect(busy).toHaveLength(42);
    release();
    await sleep(20);
    expect(
      notes.filter((n) => "reason" in n && n.reason === "epoch-not-higher"),
    ).toHaveLength(8);
  });

  it("pauses the transport at 4 MiB queued and closes with peer_busy at 8 MiB", async () => {
    const closes: string[] = [];
    const pauses: boolean[] = [];
    const link = {
      channel: { close: async (c: string) => void closes.push(c) },
      pause: (on: boolean) => void pauses.push(on),
    };
    const s = new ConnectSession(
      link as never,
      A,
      ["app/1"],
      { platform: "x", app: "y", maxMessage: 1 << 20 },
      "responder",
      "",
    );
    const chunk = new Uint8Array(1024 * 1024);
    let sent = 0;
    while (sent * chunk.length <= QUEUE_PAUSE_BYTES) {
      s.deliver({ type: 0x0100, body: chunk });
      sent++;
    }
    expect(pauses).toEqual([true]);
    expect(closes).toEqual([]);
    // Reading drains it and resumes the transport.
    for (let i = 0; i < sent; i++) await s.receive();
    expect(pauses.at(-1)).toBe(false);
    for (let i = 0; i <= QUEUE_MAX_BYTES / chunk.length; i++)
      s.deliver({ type: 0x0100, body: chunk });
    expect(closes).toEqual(["peer_busy"]);
  });
});

describe("addresses off the LAN (WIRE-CONTRACT-V5 15.4.1)", () => {
  const LL = "fe80::1c2:3ff:fe4:5a6";
  it("refuses a global IPv6 address unless the socket's own address is in the same /64", () => {
    const refuse = { dial: false, key: null };
    expect(socketVerdict("2001:db8:1:2::5", "fe80::9", false)).toEqual(refuse);
    expect(socketVerdict("2001:db8:1:2::5", undefined, false)).toEqual(refuse);
    expect(socketVerdict("2001:db8:1:2::5", "2001:db8:1:3::9", false)).toEqual(
      refuse,
    );
    expect(socketVerdict("2001:db8:1:2::5", "::ffff:10.0.0.9", false)).toEqual(
      refuse,
    );
    expect(socketVerdict("2001:db8:1:2::5", "2001:db8:1:2::9", false)).toEqual({
      dial: true,
      key: "2001:db8:1:2::5",
    });
    // Teredo and 6to4 share a /64 across the internet: never.
    expect(socketVerdict("2001:0:1:2::5", "2001:0:1:2::9", false)).toEqual(
      refuse,
    );
    expect(socketVerdict("2002:a00:1::5", "2002:a00:1::9", false)).toEqual(
      refuse,
    );
    // IPv4: public, CGNAT and link-local refuse.
    for (const a of ["8.8.8.8", "100.64.0.1", "169.254.1.1", "::ffff:8.8.8.8"])
      expect(socketVerdict(a, "10.0.0.2", false)).toEqual(refuse);
    expect(socketVerdict(undefined, "10.0.0.2", false)).toEqual(refuse);
  });

  it("judges the text before a socket exists, and refuses a mapped address with a zone", () => {
    expect(textVerdict("8.8.8.8", false)).toBe(false);
    expect(textVerdict("2001:0:1:2::5", false)).toBe(false); // Teredo
    expect(textVerdict("::1", false)).toBe(false);
    expect(textVerdict("::1", true)).toBe(true);
    expect(textVerdict(`${LL}%en0`, false)).toBe(true);
    expect(textVerdict("fd12::5", false)).toBe(true);
    // A global address might be on-link: the connected socket decides.
    expect(textVerdict("2001:db8:1:2::5", false)).toBe(true);
    expect(textVerdict("::ffff:10.0.0.1", false)).toBe(true);
    expect(textVerdict("::ffff:10.0.0.1%en0", false)).toBe(false);
    expect(
      socketVerdict("::ffff:10.0.0.1%en0", "::ffff:10.0.0.2", false).dial,
    ).toBe(false);
    expect(textVerdict("not an address", true)).toBe(false);
    expect(textVerdict(`${LL}%`, false)).toBe(false);
  });

  it("counts per address, per /64 inside the total, and keeps link-local zones apart", () => {
    const key = (remote: string) => {
      const v = socketVerdict(remote, undefined, true);
      if (v.key === null) throw new Error(`refused: ${remote}`);
      return limiterKeys(remote, v.key);
    };
    // The same fe80 address on two links is two hosts; a /64 keeps its own count per link.
    expect(key(`${LL}%en0`)).toEqual({
      address: `${LL}%en0`,
      net64: "fe80::/64%en0",
    });
    expect(key(`${LL}%wlan0`).address).toBe(`${LL}%wlan0`);
    expect(key("10.0.0.5")).toEqual({ address: "10.0.0.5", net64: null });
    expect(key("fd12:0:0:1::7").net64).toBe("fd12:0:0:1::/64");
    expect(key("::ffff:10.0.0.5")).toEqual({
      address: "10.0.0.5",
      net64: null,
    });

    const lim = new PendingLimiter(32, 4, 16);
    const held: (() => void)[] = [];
    const take = (remote: string) => {
      const r = lim.take(Symbol(remote), key(remote));
      if (r !== null) held.push(r);
      return r !== null;
    };
    // Four per address.
    for (let i = 0; i < 4; i++) expect(take("10.0.0.5")).toBe(true);
    expect(take("10.0.0.5")).toBe(false);
    // Sixteen per /64: 16 addresses of one /64 (4 each would allow 64).
    let n = 0;
    for (let i = 1; i <= 20; i++)
      if (take(`fd12:0:0:1::${i.toString(16)}`)) n++;
    expect(n).toBe(16);
    // Another /64 and another link are separate; the total of 32 is the last bound.
    expect(take(`${LL}%en0`)).toBe(true);
    expect(take(`${LL}%wlan0`)).toBe(true);
    expect(lim.size).toBe(4 + 16 + 2);
    for (let i = 1; i <= 10; i++) take(`fd12:0:0:${i + 1}::1`);
    expect(lim.size).toBe(32);
    expect(take("10.0.0.99")).toBe(false);
    // A release frees the slot in all three counts.
    held.pop()!();
    expect(take("10.0.0.99")).toBe(true);
  });
});

/** A socket as the dial race sees it: addresses, destroy and the connect and error events. */
class FakeSocket extends EventEmitter {
  destroyed = false;
  written = 0;
  constructor(
    readonly host: string,
    readonly remoteAddress: string,
    readonly localAddress: string,
  ) {
    super();
  }
  destroy(): this {
    this.destroyed = true;
    return this;
  }
  write(): boolean {
    this.written++;
    return true;
  }
}

describe("dialling several addresses (RFC 8305)", () => {
  const race = (
    hosts: string[],
    local: (host: string) => string = () => "10.0.0.2",
    allowLoopback = false,
  ) => {
    const made: FakeSocket[] = [];
    const result = dialRace(hosts, 4242, {
      allowLoopback,
      connect: (host) => {
        const s = new FakeSocket(host, host, local(host));
        made.push(s);
        return s as unknown as Socket;
      },
    });
    return { made, result };
  };

  it("starts one attempt, a second after 250 ms, and never a third while two are in flight", async () => {
    vi.useFakeTimers();
    try {
      const { made, result } = race(["10.0.0.5", "10.0.0.6", "10.0.0.7"]);
      expect(made.map((s) => s.host)).toEqual(["10.0.0.5"]);
      await vi.advanceTimersByTimeAsync(DIAL_STAGGER_MS - 1);
      expect(made).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(made.map((s) => s.host)).toEqual(["10.0.0.5", "10.0.0.6"]);
      expect(DIAL_MAX_IN_FLIGHT).toBe(2);
      await vi.advanceTimersByTimeAsync(5 * DIAL_STAGGER_MS);
      expect(made).toHaveLength(2); // both still pending: no third
      // The second connects first and wins; the first closes without a byte.
      made[1]!.emit("connect");
      const won = await result;
      expect(won).toBe(made[1]);
      expect(made[0]!.destroyed).toBe(true);
      expect(made.flatMap((s) => (s.written ? [s] : []))).toEqual([]);
      expect(made).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts the next address at once when one fails", async () => {
    const { made, result } = race(["10.0.0.5", "10.0.0.6"]);
    expect(made).toHaveLength(1);
    made[0]!.emit("error", new Error("ECONNREFUSED"));
    expect(made.map((s) => s.host)).toEqual(["10.0.0.5", "10.0.0.6"]);
    made[1]!.emit("connect");
    await expect(result).resolves.toBe(made[1]);
  });

  it("refuses a connected global address whose socket is not on its /64, and goes on", async () => {
    const { made, result } = race(["2001:db8:1:2::5", "fe80::7%en0"], (h) =>
      h.startsWith("2001") ? "fe80::9" : "fe80::9",
    );
    made[0]!.emit("connect"); // connected, but the verdict says no: closed before a byte
    expect(made[0]!.destroyed).toBe(true);
    expect(made.map((s) => s.host)).toEqual(["2001:db8:1:2::5", "fe80::7%en0"]);
    made[1]!.emit("connect");
    await expect(result).resolves.toBe(made[1]);
    expect(made[0]!.written).toBe(0);
  });

  it("accepts a connected global address on its own /64", async () => {
    const { made, result } = race(["2001:db8:1:2::5"], () => "2001:db8:1:2::9");
    made[0]!.emit("connect");
    await expect(result).resolves.toBe(made[0]);
  });

  it("rejects when every address is refused or fails, and opens no socket for a refused text", async () => {
    const { made, result } = race(["8.8.8.8", "2001:0:1:2::5", "10.0.0.5"]);
    expect(made.map((s) => s.host)).toEqual(["10.0.0.5"]); // the others were refused as text
    made[0]!.emit("error", new Error("ECONNREFUSED"));
    await expect(result).rejects.toThrow("ECONNREFUSED");
    const none = race(["8.8.8.8"]);
    await expect(none.result).rejects.toThrow("address refused");
    expect(none.made).toEqual([]);
  });
});

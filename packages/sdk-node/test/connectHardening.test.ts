// @pkey-feature connect.relay connect.lan connect.app
// The R-6 fix round for the Node transport (CC-08.2 and CC-08.3): what a hostile or broken peer,
// room or neighbour can cost. Each block pins one finding.
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { PeerDocs, type ConnectNotice } from "../src/connect/channel.js";
import {
  QUEUE_MAX_BYTES,
  QUEUE_PAUSE_BYTES,
  ConnectSession,
} from "../src/connect/index.js";
import type { LanSource } from "../src/connect/lan.js";
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

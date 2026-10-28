// @pkey-feature connect.relay connect.app
// D-9 (the relay pacer and the 8 MiB send queue) and D-12 (sign-out stops Connect within a bound)
// for the Node transport. The pacer's arithmetic is pinned in client-core's relayPacer.test.ts;
// these tests pin that the relay service uses it.
import { describe, expect, it, vi } from "vitest";
import { RelayPacer } from "@polaris-key/client-core/peer";
import { devId, until } from "./lanFixtures.js";
import { FakeRoom, ManualTimer, relayHarness } from "./relayFixtures.js";

const A = devId("1");
const { world, svc, clients } = relayHarness();

const viaRelay = (room: FakeRoom, relay: object = {}) => ({
  relay: { ...relay, webSocket: room.webSocket },
  lan: false as const,
});

describe("D-9: the relay send path is paced", () => {
  it("LIMIT 1 halves the rate for 10 s, then it recovers", async () => {
    const { a, room } = await world();
    let ms = 0;
    const pace = new RelayPacer(180, 360, () => ms);
    const relay = svc(a, room, new ManualTimer(), { outbox: { pacer: pace } });
    await relay.ready();
    expect(pace.rate).toBe(180);
    room.sockets.forEach((k) => k.deliver({ op: "limit", reason: 1 }));
    await until(() => pace.rate === 90);
    ms = 9_999;
    expect(pace.rate).toBe(90);
    ms = 10_001;
    expect(pace.rate).toBe(180);
  });

  it("a session message past the 8 MiB queue closes that session peer_busy", async () => {
    const { a, b, room } = await world();
    const pace = new RelayPacer(180, 360, () => 0);
    await a.cloudConnect.start(viaRelay(room));
    await b.cloudConnect.start(
      viaRelay(room, { outbox: { pacer: pace, maxBytes: 4096 } }),
    );
    await until(() => b.cloudConnect.peers().some((p) => p.deviceId === A));
    const link = await b.cloudConnect.open(A);
    // The clock never moves: spend the burst, and nothing more leaves the queue.
    while (pace.tryTake() === 0);
    await link.send(new Uint8Array(100_000)).catch(() => undefined);
    expect(link.closed?.code).toBe("peer_busy");
    expect(link.closed?.byPeer).toBe(false);
    expect(b.cloudConnect.status().running).toBe(true);
  });
});

describe("D-12: Connect stops before sign-out, within a bound", () => {
  it("a stop that a host callback holds is force-cancelled at the bound", async () => {
    const { a, b, room } = await world();
    await a.cloudConnect.start(viaRelay(room));
    await b.cloudConnect.start(viaRelay(room));
    await until(() => b.cloudConnect.peers().some((p) => p.deviceId === A));
    const out = await b.cloudConnect.open(A);
    // A session whose close never settles: a graceful stop would wait for it for ever.
    out.close = () => new Promise<void>(() => undefined);
    const t0 = Date.now();
    await b.cloudConnect.stopForSignOut(50);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(b.cloudConnect.status()).toMatchObject({
      running: false,
      relay: "off",
    });
    await until(() => room.sockets.every((s) => s.device === A));
    expect(room.sockets.some((s) => s.device !== A)).toBe(false);
  });

  it("the before-sign-out hooks stop Connect, then leave", async () => {
    const { a } = await world();
    const order: string[] = [];
    vi.spyOn(a.cloudConnect, "stopForSignOut").mockImplementation(async () => {
      order.push("stop");
    });
    vi.spyOn(a.connect, "leave").mockImplementation(async () => {
      order.push("leave");
    });
    await (
      a.identity as unknown as { beforeSignOut: { run(): Promise<void> } }
    ).beforeSignOut.run();
    expect(order).toEqual(["stop", "leave"]);
    expect(clients.length).toBeGreaterThan(0);
  });
});

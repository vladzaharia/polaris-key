// @vitest-environment node
//
// @pkey-feature connect.relay connect.app connect.noise connect.protocol
//
// Cloud Connect over the relay in the browser (CC-09.2; WIRE-CONTRACT-V5 §15.7): the ticket, the
// envelope framing, sessions admitted exactly as on the LAN (a real XXpsk0 handshake between two
// devices, over client-core's WebCrypto Noise), reconnect with backoff, Retry-After capped, the
// typed quota and pause errors, byte-capped queues, pushed RING and TRUST documents, and the rule
// that nothing secret is reachable from a print. The room is a faithful in-process copy of the
// CC-07 engine's framing (the same one sdk-node's relayFixtures.ts uses). Mirrors sdk-node's
// relay.test.ts and connectHardening.test.ts (the relay parts).

import {
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import type { DeviceKeyPort } from "@polaris-key/client-core";
import { signJws } from "@polaris-key/jws";
import {
  decodeRelay,
  deviceIdBytes,
  encodeRelay,
  RelayPacer,
  type RelayMessage,
} from "@polaris-key/client-core/peer";
import { BrowserAdapter } from "../src/browser/browserAdapter.js";
import { indexedDbStore } from "../src/browser/bearer/store.js";
import { indexedDbOfflineStore } from "../src/browser/offline.js";
import {
  LanError,
  RELAY_MODES,
  RelayError,
  assertRelayMode,
  createCloudConnect,
  unsupportedCloudConnect,
  type ConnectNotice,
  type ConnectSession,
} from "../src/browser/connect/index.js";
import {
  PeerDocs,
  type PeerSource,
} from "@polaris-key/ui-core/browser/sdk/browser/connect/channel.js";
import {
  RelayService,
  type RelaySocket,
  type RelaySource,
} from "@polaris-key/ui-core/browser/sdk/browser/connect/relay.js";
import { QUEUE_MAX_BYTES } from "@polaris-key/ui-core/browser/sdk/browser/connect/session.js";
import { createConnect } from "../src/browser/connect/create.js";
import { XferStore } from "@polaris-key/ui-core/browser/sdk/browser/connect/xferStore.js";
import { indexedDbConnectState } from "../src/browser/connect/state.js";
import { discoveryBody, services } from "./fixtures.js";

import {
  A,
  B,
  BASE,
  CORPUS,
  type Dev,
  FakeRoom,
  FakeSock,
  HERE,
  ManualTimer,
  OPEN_MS,
  PIN,
  PING_MS,
  PRODUCT,
  SUB,
  T0,
  TOKEN,
  TRUST,
  WEEK,
  X25519_SPKI,
  b64,
  devId,
  device,
  isBackoff,
  live,
  pair,
  raw32,
  signCert,
  signRing,
  sleep,
  until,
  utf8,
  world,
} from "./relayFixtures.js";

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
});

describe("the relay ticket as the socket sees it", () => {
  it("offers pkey-relay.1 and the ticket as the two subprotocols, a fresh ticket each connect", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(w.a, t);
    await r.ready();
    expect(w.room.offered[0]![0]).toBe("pkey-relay.1");
    expect(w.room.offered[0]![1]).toMatch(/^pkeyrt_/);
    w.room.made[0]!.shut(1006);
    await until(() => t.pending.some((p) => isBackoff(p.ms)));
    t.fire(isBackoff);
    await until(() => w.room.offered.length === 2);
    expect(w.room.offered[1]![1]).not.toBe(w.room.offered[0]![1]);
    expect(w.calls.tickets).toBe(2);
  });
});

describe("sessions over the relay", () => {
  it("admits the peer like the LAN does (real Noise, certificates, roster) and carries messages both ways", async () => {
    const { out, inn, room, a, b } = await pair();
    expect(out.path).toBe("relay");
    expect(inn.path).toBe("relay");
    expect(out.peerDeviceId).toBe(a.id);
    expect(inn.peerDeviceId).toBe(b.id);
    await out.send(utf8("over the room"));
    expect(new TextDecoder().decode((await inn.receive()).body)).toBe(
      "over the room",
    );
    await inn.send(utf8("and back"), 0x0102);
    expect(await out.receive()).toMatchObject({ type: 0x0102 });
    // A message bigger than one frame is split into records and reassembled.
    await out.send(new Uint8Array(200_000).fill(7));
    expect((await inn.receive()).body.length).toBe(200_000);
    // The client only ever wrote SEND, LIST and PING.
    for (const r of room.received)
      expect(["send", "list", "ping"]).toContain(r.msg.op);
    expect(room.sends(b.id).length).toBeGreaterThan(0);
    await out.close();
    await until(() => inn.closed !== null);
  });

  it("refuses to dial a device that is not on the roster, typed", async () => {
    const w = await world();
    const r = await w.svc(w.a, new ManualTimer());
    await r.ready();
    await expect(r.dial(devId("9"))).rejects.toMatchObject({
      name: "RelayError",
      reason: "unknown_peer",
      code: "invalid-argument",
    });
    await expect(r.dial("short")).rejects.toMatchObject({
      reason: "unknown_peer",
    });
  });

  it("ignores a first message from a device that is not on the roster", async () => {
    const w = await world();
    const r = await w.svc(w.a, new ManualTimer());
    let got = 0;
    r.onSession(() => got++);
    await r.ready();
    w.room.inject(devId("7"), A, 1, new Uint8Array(48).fill(1));
    await sleep(40);
    expect(got).toBe(0);
    expect(w.room.sends(A)).toHaveLength(0);
  });

  it("carries mode a only: v and p never cross", () => {
    expect([...RELAY_MODES]).toEqual(["a"]);
    expect(assertRelayMode("a")).toBe("a");
    for (const mode of ["v", "p", "x"])
      expect(() => assertRelayMode(mode)).toThrowError(
        expect.objectContaining({
          name: "RelayError",
          reason: "mode_not_allowed",
          code: "invalid-argument",
        }),
      );
  });

  it("closes an unread session with peer_busy past the byte cap", async () => {
    const { out, inn } = await pair();
    const chunk = new Uint8Array(1_000_000).fill(3);
    const n = Math.ceil(QUEUE_MAX_BYTES / chunk.length) + 1;
    for (let i = 0; i < n && out.closed === null; i += 1)
      await out.send(chunk).catch(() => undefined);
    await until(() => inn.closed !== null);
    expect(inn.closed!.code).toBe("peer_busy");
  }, 30_000);

  it("the errors are PolarisErrors with registered codes", () => {
    const codes: [ConstructorParameters<typeof RelayError>[0], string][] = [
      ["disabled", "relay_disabled"],
      ["paused", "relay_paused"],
      ["quota", "relay_quota_exceeded"],
      ["ticket_invalid", "relay_ticket_invalid"],
      ["not_connected", "connect-unavailable"],
      ["wrong_peer", "peer-cert-invalid"],
      ["handshake_failed", "peer-cert-invalid"],
    ];
    for (const [reason, code] of codes)
      expect(new RelayError(reason, "x")).toMatchObject({ code });
    expect(new LanError("wrong_peer", "x").code).toBe("peer-cert-invalid");
    expect(new LanError("not_started", "x").code).toBe("not-configured");
  });
});

describe("reconnect, backoff and the typed stops", () => {
  it("does not reset the backoff on an accept-then-close loop, only after a stable socket", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(w.a, t);
    await r.ready();
    const backoffs = () => t.delays.filter(isBackoff);
    w.room.made[0]!.shut(1006);
    await until(() => backoffs().length === 1);
    t.fire(isBackoff);
    await until(() => r.status.state === "open");
    w.room.made[1]!.shut(1006);
    await until(() => backoffs().length === 2);
    // 750 ms (attempt 1, equal jitter at 0.5), then 1500 ms: the open in between reset nothing.
    expect(backoffs()).toEqual([750, 1500]);
    expect(r.status.attempts).toBe(2);

    // A socket that stays open for the stable window does reset it.
    const u = new ManualTimer();
    const stable = await w.svc(w.b, u, { stableMs: 0 });
    await stable.ready();
    w.room.made[w.room.made.length - 1]!.shut(1006);
    await until(() => u.delays.filter(isBackoff).length === 1);
    u.fire(isBackoff);
    await until(() => stable.status.state === "open");
    w.room.made[w.room.made.length - 1]!.shut(1006);
    await until(() => u.delays.filter(isBackoff).length === 2);
    expect(u.delays.filter(isBackoff)).toEqual([750, 750]);
  });

  it("never waits less than the floor", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(w.a, t, {
      random: () => 0,
      backoffBaseMs: 1,
      backoffMaxMs: 1,
    });
    await r.ready();
    w.room.made[0]!.shut(1006);
    await until(() => t.delays.some(isBackoff));
    expect(t.delays.filter(isBackoff)[0]).toBe(500);
  });

  it("caps Retry-After at 3600 s", async () => {
    const w = await world();
    const t = new ManualTimer();
    await w.svc(
      w.a,
      t,
      {},
      {
        ticket: async () => {
          throw new RelayError("paused", "paused", { retryAfterSeconds: 1e12 });
        },
      },
    );
    await until(() => t.delays.some(isBackoff));
    expect(t.delays.filter(isBackoff)).toEqual([3_600_000]);
    const u = new ManualTimer();
    await w.svc(
      w.b,
      u,
      {},
      {
        ticket: async () => {
          throw new RelayError("paused", "paused", { retryAfterSeconds: 300 });
        },
      },
    );
    await until(() => u.delays.some(isBackoff));
    expect(u.delays.filter(isBackoff)).toEqual([300_000]);
  });

  it("stops with the typed error when the product turned the relay off", async () => {
    const w = await world();
    const r = await w.svc(
      w.a,
      new ManualTimer(),
      {},
      {
        ticket: async () => {
          throw new RelayError("disabled", "off");
        },
      },
    );
    await expect(r.ready()).rejects.toMatchObject({
      name: "RelayError",
      reason: "disabled",
      code: "relay_disabled",
    });
    expect(r.status.state).toBe("blocked");
  });

  it("stops on a spent quota (LIMIT then close 4008), with its scope, and resumes on request", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(w.a, t);
    await r.ready();
    const sock = w.room.made[0]!;
    sock.deliver({ op: "limit", reason: 3 });
    await sleep(20);
    sock.shut(4008);
    await until(() => r.status.state === "blocked");
    expect(r.status.error).toMatchObject({
      reason: "quota",
      scope: "product",
      code: "relay_quota_exceeded",
    });
    r.resume();
    await r.ready();
    expect(r.status.state).toBe("open");
  });

  it("does not fight a replaced socket (4009)", async () => {
    const w = await world();
    const r = await w.svc(w.a, new ManualTimer());
    await r.ready();
    w.room.made[0]!.shut(4009);
    await until(() => r.status.state === "blocked");
    expect(r.status.error).toMatchObject({ reason: "replaced" });
    expect(w.room.made).toHaveLength(1);
  });

  it("refuses an envelope that fails its layout with 1002", async () => {
    const w = await world();
    const r = await w.svc(w.a, new ManualTimer());
    await r.ready();
    const sock = w.room.made[0]!;
    sock.deliver(new Uint8Array([0xff, 1, 2]));
    await until(() => sock.closeCode === 1002);
    expect(r.status.state).not.toBe("stopped");
  });
});

// ── Pushed documents ───────────────────────────────────────────────────────────────────────────

function docs(over: Partial<PeerSource> = {}) {
  const t = new ManualTimer();
  let now = T0;
  const calls = { refresh: 0 };
  const notices: ConnectNotice[] = [];
  const src: PeerSource = {
    now: () => now,
    load: async () => {
      throw new Error("unused");
    },
    refresh: async () => {
      calls.refresh += 1;
    },
    adoptRing: async () => ({ stored: true, epoch: 2 }),
    applyTrust: async () => ({ applied: true }),
    ...over,
  };
  const d = new PeerDocs(src, () => undefined, t.timer);
  d.onNotice((n) => notices.push(n));
  return { d, t, calls, notices, at: (s: number) => (now = s) };
}

describe("pushed RING and TRUST", () => {
  it("reports a stored roster, then refreshes once, and a second push in the same minute is deferred", async () => {
    const x = docs();
    x.d.ring("r1");
    await until(() => x.calls.refresh === 1);
    expect(x.notices).toEqual([{ type: "ring", outcome: "stored", epoch: 2 }]);
    x.d.ring("r2");
    await until(() => x.notices.length === 2);
    expect(x.calls.refresh).toBe(1);
    // The slot is taken: the refresh waits out the minute and then runs.
    const wait = x.t.pending.find((p) => p.ms > 0)!;
    expect(wait.ms).toBe(60_000);
    x.at(T0 + 61);
    x.t.fire((ms) => ms === 60_000);
    await until(() => x.calls.refresh === 2);
  });

  it("asks for a roster at most once a minute", () => {
    const x = docs();
    expect(x.d.wantRing()).toBe(true);
    expect(x.d.wantRing()).toBe(false);
    x.at(T0 + 59);
    expect(x.d.wantRing()).toBe(false);
    x.at(T0 + 60);
    expect(x.d.wantRing()).toBe(true);
    expect(x.calls.refresh).toBe(2);
  });

  it("reports a refused roster and a trust manifest, applied or refused, never silently", async () => {
    const x = docs({
      adoptRing: async () => ({ stored: false, reason: "epoch-not-higher" }),
      applyTrust: async (jws) =>
        jws === "good"
          ? { applied: true }
          : { applied: false, reason: "not_newer" },
    });
    x.d.ring("r");
    x.d.trust("good");
    x.d.trust("old");
    await until(() => x.notices.length === 3);
    expect(x.notices).toEqual([
      { type: "ring", outcome: "refused", reason: "epoch-not-higher" },
      { type: "trust", outcome: "applied" },
      { type: "trust", outcome: "refused", reason: "not_newer" },
    ]);
    expect(x.calls.refresh).toBe(0);
  });

  it("caps the documents waiting, refusing the rest as busy", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const x = docs({
      applyTrust: async () => {
        await gate;
        return { applied: true };
      },
    });
    for (let i = 0; i < 12; i += 1) x.d.trust(`m${i}`);
    // A flood is one notice a second, not one per refused document.
    expect(x.notices).toEqual([
      { type: "trust", outcome: "refused", reason: "busy" },
    ]);
    // The same document twice is one, and quietly so inside the second.
    x.d.trust("m0");
    expect(x.notices).toHaveLength(1);
    // One slot is kept for a roster: seven manifests wait and a RING is still taken.
    x.d.ring("r-late");
    expect(x.notices).toHaveLength(1);
    release();
  });

  it("hands a pushed RING through a live session to the source, and a ring-wanted refresh", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(w.a, t);
    await r.ready();
    // The room says the roster is at epoch 2: it asks for a newer one (once).
    w.room.sockets[0]!.deliver({ op: "ring", epoch: 2 });
    w.room.sockets[0]!.deliver({ op: "ring", epoch: 3 });
    await until(() => w.calls.refresh >= 1);
    await sleep(30);
    expect(w.calls.refresh).toBe(1);
  });
});

// ── Nothing secret in a print ───────────────────────────────────────────────────────────────────

describe("secrets", () => {
  it("K_disc and the channel are in no JSON, enumerable field or inspect of a session or the service", async () => {
    const { out, inn, disc, ra } = await pair();
    const secrets = [b64(disc), Buffer.from(disc).toString("hex")];
    for (const o of [out, inn, ra]) {
      const views = [
        JSON.stringify(o),
        inspect(o, { depth: 12, showHidden: true }),
        Object.keys(o).join(","),
        Object.getOwnPropertyNames(o).join(","),
      ];
      for (const v of views)
        for (const s of secrets) expect(v).not.toContain(s);
      for (const key of Object.keys(o))
        expect(["channel", "discKeys", "account", "src"]).not.toContain(key);
    }
    expect(JSON.stringify(out)).toContain("ConnectSession");
  });
});

// ── The engine behind the adapter ───────────────────────────────────────────────────────────────

const ME = devId("3");
const OTHER = devId("4");

class FakeWorker {
  epoch = 1;
  sub = SUB;
  me = device(ME);
  other = device(OTHER);
  disc = [b64(randomBytes(32))];
  registered = false;
  ticket: () => Response = () => this.okTicket();
  reqs: string[] = [];
  withOther = true;
  delay = 0;
  inFlight = 0;
  maxInFlight = 0;
  okTicket(url = `wss://key.plrs.im/${PRODUCT}/connect/relay`): Response {
    return new Response(
      JSON.stringify({
        ticket: `pkeyrt_${b64(randomBytes(24))}`,
        url,
        protocol: "pkey-relay.1",
        expiresAt: T0 + 60,
      }),
      { status: 200 },
    );
  }
  ring(epoch = this.epoch, withOther = this.withOther, sub = this.sub) {
    return signRing(withOther ? [this.me, this.other] : [this.me], epoch, sub);
  }
  fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(`/${PRODUCT}/`, "");
    this.reqs.push(`${method} ${path}`);
    const j = (b: unknown, s = 200) =>
      new Response(JSON.stringify(b), { status: s });
    if (path === ".well-known/polaris.json") {
      const doc = JSON.parse(discoveryBody(services("license"), PRODUCT));
      doc.services.connect = {
        enabled: true,
        endpoints: { identity: `${BASE}/${PRODUCT}/connect/identity` },
      };
      return j(doc);
    }
    if (path === ".well-known/polaris-trust.jws")
      return new Response("", { status: 404 });
    if (method === "PUT" && path === "devices/keys") {
      this.registered = true;
      return j({ keySeq: 1 });
    }
    if (path === "connect/identity") {
      this.inFlight += 1;
      this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
      if (this.delay > 0) await sleep(this.delay);
      this.inFlight -= 1;
    }
    if (path === "connect/identity")
      return j({
        ring: await this.ring(),
        certificate: await signCert(this.me, this.epoch),
        discKeys: this.disc,
      });
    if (path === "connect/relay/ticket") return this.ticket();
    if (path === "connect/devices") return j({ devices: [] });
    return j({}, 404);
  }) as typeof fetch;
}

async function adapterWorld(
  pinned = true,
  share?: { worker: FakeWorker; factory: IDBFactory },
) {
  const worker = share?.worker ?? new FakeWorker();
  const factory = share?.factory ?? new IDBFactory();
  (globalThis as { indexedDB?: unknown }).indexedDB = factory;
  await indexedDbOfflineStore(factory)!.write(PRODUCT, { deviceId: ME });
  const bearer = indexedDbStore(PRODUCT, { factory })!;
  await bearer.setToken(TOKEN);
  const adapter = new BrowserAdapter({
    productSlug: PRODUCT,
    ...(pinned ? { trust: { pinnedKeys: TRUST } } : {}),
    fetchImpl: worker.fetch,
    now: () => T0,
    store: bearer,
    connect: { deviceKeys: worker.me.port },
    autoStart: false,
  });
  return { worker, factory, adapter };
}

afterEach(() => {
  delete (globalThis as { indexedDB?: unknown }).indexedDB;
});

describe("the ticket route through the adapter", () => {
  it("accepts only a pkeyrt_ ticket, wss, the Worker's own host and pkey-relay.1", async () => {
    const { worker, adapter } = await adapterWorld();
    const g = await adapter.connect.relayTicket();
    expect(g).toMatchObject({
      url: `wss://key.plrs.im/${PRODUCT}/connect/relay`,
      protocol: "pkey-relay.1",
      expiresAt: T0 + 60,
    });
    expect(g.ticket).toMatch(/^pkeyrt_[A-Za-z0-9_-]{32}$/);
    for (const url of [
      "wss://evil.test/acme/connect/relay",
      "ws://key.plrs.im/acme/connect/relay",
      "https://key.plrs.im/acme/connect/relay",
    ]) {
      worker.ticket = () => worker.okTicket(url);
      await expect(adapter.connect.relayTicket()).rejects.toMatchObject({
        name: "RelayError",
        reason: "ticket_invalid",
        code: "relay_ticket_invalid",
      });
    }
    worker.ticket = () =>
      new Response(
        JSON.stringify({
          ticket: "pkeyrt_short",
          url: "wss://key.plrs.im/x",
          protocol: "pkey-relay.1",
          expiresAt: 1,
        }),
        { status: 200 },
      );
    await expect(adapter.connect.relayTicket()).rejects.toMatchObject({
      reason: "ticket_invalid",
    });
  });

  it("types the refusals: off, paused with Retry-After, quota with its scope", async () => {
    const { worker, adapter } = await adapterWorld();
    const refuse = (
      status: number,
      code: string,
      extra: object = {},
      headers: Record<string, string> = {},
    ) => {
      worker.ticket = () =>
        new Response(JSON.stringify({ error: { code }, ...extra }), {
          status,
          headers,
        });
    };
    refuse(403, "relay_disabled");
    await expect(adapter.connect.relayTicket()).rejects.toMatchObject({
      reason: "disabled",
      status: 403,
    });
    refuse(503, "relay_paused", {}, { "retry-after": "300" });
    await expect(adapter.connect.relayTicket()).rejects.toMatchObject({
      reason: "paused",
      retryAfterSeconds: 300,
    });
    refuse(429, "relay_quota_exceeded", { scope: "person" });
    await expect(adapter.connect.relayTicket()).rejects.toMatchObject({
      reason: "quota",
      scope: "person",
    });
    refuse(401, "unauthorized");
    const e = await adapter.connect.relayTicket().catch((x: unknown) => x);
    expect(e).not.toBeInstanceOf(RelayError);
    expect(e).toMatchObject({ status: 401 });
  });
});

describe("a pushed roster through the identity replacement rules", () => {
  it("stores a newer roster, marks K_disc stale when a device left, and a refresh brings the new one back", async () => {
    const { worker, adapter } = await adapterWorld();
    const src = adapter.connect.relaySource();
    await adapter.connect.identity();
    expect(await adapter.connect.discoveryKeys()).not.toBeNull();
    // Same epoch, a lower one and a foreign subject are refused; the held state is unchanged.
    expect(await src.adoptRing!(await worker.ring(1))).toMatchObject({
      stored: false,
      reason: "epoch-not-higher",
    });
    expect(
      await src.adoptRing!(
        await worker.ring(2, true, "ps_BBBBBBBBBBBBBBBBBBBBBB"),
      ),
    ).toMatchObject({
      stored: false,
      reason: "other-product-or-subject",
    });
    // A roster that drops this device is refused.
    expect(
      await src.adoptRing!(await signRing([worker.other], 2)),
    ).toMatchObject({ stored: false, reason: "device_not_in_roster" });
    // A newer roster without the other device is stored; the old K_disc is not used.
    expect(await src.adoptRing!(await worker.ring(2, false))).toEqual({
      stored: true,
      epoch: 2,
    });
    expect(await adapter.connect.discoveryKeys()).toBeNull();
    await expect(src.load()).rejects.toMatchObject({
      name: "LanError",
      reason: "no_keys",
    });
    // The Worker's refresh brings the certificate and a new K_disc for epoch 2.
    worker.epoch = 2;
    worker.withOther = false;
    worker.disc = [b64(randomBytes(32))];
    await src.refresh!();
    expect(await adapter.connect.discoveryKeys()).not.toBeNull();
    expect((await adapter.connect.current())?.epoch).toBe(2);
  });
});

describe("a roster that drops a device", () => {
  it("purges that device's kept transfers without any session open, and no one else's", async () => {
    const purged = vi
      .spyOn(XferStore.prototype, "purgePeer")
      .mockResolvedValue(undefined);
    try {
      const { worker, adapter } = await adapterWorld();
      const src = adapter.connect.relaySource();
      // The facade is made (nothing is started, no session exists).
      expect(adapter.cloudConnect.peers()).toEqual([]);
      await adapter.connect.identity();
      // Same roster again: nobody left.
      await adapter.connect.identity({ refresh: true });
      expect(purged).not.toHaveBeenCalled();
      expect(await src.adoptRing!(await worker.ring(2, false))).toEqual({
        stored: true,
        epoch: 2,
      });
      await until(() => purged.mock.calls.length === 1);
      expect(Buffer.from(purged.mock.calls[0]![0]).toString("base64url")).toBe(
        worker.other.agreeKey,
      );
    } finally {
      purged.mockRestore();
    }
  });
});

describe("leave() and the database", () => {
  it("creates no empty database for an app that never used Connect, and clears one that did", async () => {
    const { factory, adapter } = await adapterWorld();
    await adapter.connect.leave();
    const names = async () => (await factory.databases()).map((d) => d.name);
    expect(await names()).not.toContain(
      `pkey-connect-${PRODUCT}-${new URL(BASE).host}`,
    );
    expect(
      (await names()).filter((n) => n?.startsWith("pkey-connect")),
    ).toEqual([]);
    await adapter.connect.identity();
    expect((await names()).some((n) => n?.startsWith("pkey-connect"))).toBe(
      true,
    );
    await adapter.connect.leave();
    expect(await adapter.connect.current()).toBeNull();
  });

  it("fails closed: only a databases() list that confirms absence lets sign-out skip the store", async () => {
    const mk = (databases: unknown) => {
      const factory = new IDBFactory();
      Object.defineProperty(factory, "databases", { value: databases });
      return indexedDbConnectState("pkey-connect-x", factory);
    };
    // No databases() (older engines) and a failing one: may hold, whatever a marker says.
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    try {
      expect(await mk(undefined).mayHold!()).toBe(true);
      expect(
        await mk(async () => {
          throw new Error("no");
        }).mayHold!(),
      ).toBe(true);
    } finally {
      delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    expect(await mk(async () => []).mayHold!()).toBe(false);
    expect(
      await mk(async () => [{ name: "pkey-connect-x", version: 1 }]).mayHold!(),
    ).toBe(true);
    // And the facade's leave() really clears a record when databases() is missing.
    const { factory, adapter } = await adapterWorld();
    Object.defineProperty(factory, "databases", { value: undefined });
    await adapter.connect.identity();
    await adapter.connect.leave();
    expect(await adapter.connect.current()).toBeNull();
  });
});

describe("adapter.cloudConnect", () => {
  it("is the typed runtime N/A on a page without pinned keys and the desktop's version N/A", async () => {
    const { adapter } = await adapterWorld(false);
    expect(adapter.cloudConnect.unsupported).toMatchObject({
      reason: "runtime",
      feature: "connect.app",
    });
    await expect(adapter.cloudConnect.start()).rejects.toMatchObject({
      name: "UnsupportedError",
      code: "connect-unavailable",
    });
    expect(adapter.cloudConnect.peers()).toEqual([]);
    expect(unsupportedCloudConnect("version", "x").unsupported?.reason).toBe(
      "version",
    );
  });

  it("start() brings the relay up over the browser's WebSocket, lists peers, refuses open before start, and stop() closes it", async () => {
    const { adapter } = await adapterWorld();
    const cc = adapter.cloudConnect;
    await expect(cc.open(OTHER)).rejects.toMatchObject({
      reason: "not_started",
      code: "not-configured",
    });
    const room = new FakeRoom();
    room.members.add(ME).add(OTHER);
    let sockets = 0;
    const fakeSocket = (url: string, protocols: string[]): RelaySocket => {
      sockets += 1;
      // The Worker's own ticket route issued this ticket: admit it.
      room.tickets.set(protocols[1]!, ME);
      return room.webSocket(url, protocols);
    };
    let changes = 0;
    cc.onChange(() => (changes += 1));
    expect(cc.status().relay).toBe("off");
    await cc.start({
      relay: { webSocket: fakeSocket, timer: new ManualTimer().timer },
    });
    await until(() => cc.status().relay === "open");
    expect(sockets).toBe(1);
    expect(cc.status()).toMatchObject({ running: true, lan: "off" });
    // The relay asks for the roster as soon as it opens. Let that answer land first: a
    // refresh sent before it would resolve on the stale answer (only this device) on a slow runner.
    await until(() => room.received.some((r) => r.msg.op === "list"));
    await sleep(5); // the answer's 0 ms delivery timer was queued before this one
    // Another device joins the room.
    const other = new FakeSock(room, "u", ["pkey-relay.1", "t"]);
    other.device = OTHER;
    other.open = true;
    room.sockets.push(other);
    expect((await cc.refreshPeers()).map((p) => p.deviceId)).toEqual([OTHER]);
    expect(cc.peers()[0]).toEqual({ deviceId: OTHER, lan: false, relay: true });
    expect(changes).toBeGreaterThan(0);
    await cc.stop();
    expect(cc.status().relay).toBe("off");
    expect(room.made[0]!.closed).toBe(true);
    await cc.stop();
  });

  it("the facade loads nothing until start()", async () => {
    const calls: string[] = [];
    const fake = createConnect({
      product: PRODUCT,
      baseUrl: BASE,
      device: async () => ({ deviceId: ME, hasToken: false }),
      request: async () => new Response("{}"),
      registerKeys: async () => undefined,
      trust: () => TRUST,
      now: () => T0,
      discovery: async () => null,
      keys: () => device(ME).port,
      allowEphemeralKeys: false,
      stores: {
        durable: () => {
          calls.push("durable");
          throw new Error("x");
        },
        memory: {
          persistence: "memory",
          get: async () => null,
          put: async () => undefined,
          clear: async () => undefined,
        },
      },
    });
    const cc = createCloudConnect(fake);
    expect(cc.peers()).toEqual([]);
    await cc.stop();
    expect(calls).toEqual([]);
    await expect(cc.start()).rejects.toMatchObject({ code: "no-token" });
  });
});

// ── D-9 pacing and D-12 sign-out ─────────────────────────────────────────────────────────────

describe("D-9: the relay send path is paced", () => {
  it("LIMIT 1 halves the rate for 10 s, then it recovers", async () => {
    const w = await world();
    let now = 0;
    const pacer = new RelayPacer(180, 360, () => now);
    const r = await w.svc(w.a, new ManualTimer(), { outbox: { pacer } });
    await r.ready();
    expect(pacer.rate).toBe(180);
    w.room.made[0]!.deliver({ op: "limit", reason: 1 });
    await until(() => pacer.rate === 90);
    now = 9_999;
    expect(pacer.rate).toBe(90);
    now = 10_001;
    expect(pacer.rate).toBe(180);
  });

  it("a session message past the queue cap closes that session peer_busy", async () => {
    const w = await world();
    let now = 0;
    const pacer = new RelayPacer(180, 360, () => now);
    const ra = await w.svc(w.a, new ManualTimer());
    const rb = await w.svc(w.b, new ManualTimer(), {
      outbox: { pacer, maxBytes: 4096 },
    });
    await ra.ready();
    await rb.ready();
    await until(() => rb.members().includes(A));
    const out = await rb.dial(A);
    // The clock is frozen: spend the burst, so nothing leaves the queue.
    while (pacer.tryTake() === 0);
    await out.send(new Uint8Array(100_000)).catch(() => undefined);
    expect(out.closed).toEqual({ code: "peer_busy", byPeer: false });
  });
});

describe("D-12: Connect stops before sign-out, within a bound", () => {
  const beforeSignOut = (adapter: unknown) =>
    (
      adapter as {
        bearer: { beforeSignOut: { run(): Promise<void> } };
      }
    ).bearer.beforeSignOut.run();

  async function started() {
    const { adapter } = await adapterWorld();
    const room = new FakeRoom();
    room.members.add(ME);
    const cc = adapter.cloudConnect;
    await cc.start({
      relay: {
        webSocket: (url, protocols) => {
          room.tickets.set(protocols[1]!, ME);
          return room.webSocket(url, protocols);
        },
        timer: new ManualTimer().timer,
      },
    });
    await until(() => cc.status().relay === "open");
    return { adapter, cc, room };
  }

  it("the before-sign-out hooks stop it", async () => {
    const { adapter, cc, room } = await started();
    await beforeSignOut(adapter);
    expect(cc.status()).toMatchObject({ running: false, relay: "off" });
    expect(room.made[0]!.closed).toBe(true);
  });

  it("a stop that is held up is force-cancelled at 15 s, and the sign-out goes on", async () => {
    const { adapter, cc, room } = await started();
    // The graceful close never settles: a host callback holding it would wait for ever.
    const real = RelayService.prototype.stop;
    const stop = vi
      .spyOn(RelayService.prototype, "stop")
      .mockImplementation(function (this: RelayService, graceful = true) {
        return graceful
          ? new Promise<void>(() => undefined)
          : real.call(this, false);
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const done = beforeSignOut(adapter);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(room.made[0]!.closed).toBe(false);
      await vi.advanceTimersByTimeAsync(2);
      await done;
    } finally {
      vi.useRealTimers();
      stop.mockRestore();
    }
    expect(cc.status()).toMatchObject({ running: false, relay: "off" });
    expect(room.made[0]!.closed).toBe(true);
  });
});

// ── Two tabs on one database (R-6w) ───────────────────────────────────────────────────────────

/** Web Locks as a browser has them, shared by every "tab" of the test. */
function installLocks(): () => void {
  const state = new Map<string, { busy: boolean; q: (() => void)[] }>();
  const locks = {
    request(name: string, a: unknown, b?: unknown): Promise<unknown> {
      const opts = (typeof a === "function" ? {} : a) as {
        ifAvailable?: boolean;
        signal?: AbortSignal;
      };
      const fn = (typeof a === "function" ? a : b) as (l: unknown) => unknown;
      let st = state.get(name);
      if (!st) state.set(name, (st = { busy: false, q: [] }));
      const q = st;
      return new Promise((resolve, reject) => {
        const run = async () => {
          q.busy = true;
          try {
            resolve(await fn({ name }));
          } catch (e) {
            reject(e);
          } finally {
            q.busy = false;
            q.q.shift()?.();
          }
        };
        if (!q.busy) return void run();
        if (opts.ifAvailable) {
          Promise.resolve(fn(null)).then(resolve, reject);
          return;
        }
        q.q.push(run);
        opts.signal?.addEventListener("abort", () => {
          const i = q.q.indexOf(run);
          if (i >= 0) {
            q.q.splice(i, 1);
            reject(new Error("AbortError"));
          }
        });
      });
    },
  };
  const was = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    value: { locks },
    configurable: true,
  });
  return () => {
    if (was) Object.defineProperty(globalThis, "navigator", was);
    else delete (globalThis as { navigator?: unknown }).navigator;
  };
}

describe("two tabs of one app", () => {
  let undo = () => {};
  afterEach(() => undo());

  it("serialise the record across tabs: one identity fetch at a time, and a leave is not resurrected", async () => {
    undo = installLocks();
    const t1 = await adapterWorld();
    const t2 = await adapterWorld(true, t1);
    t1.worker.delay = 15;
    await Promise.all([
      t1.adapter.connect.identity({ refresh: true }),
      t2.adapter.connect.identity({ refresh: true }),
    ]);
    expect(t1.worker.maxInFlight).toBe(1);
    // Tab 2's fetch is in flight when tab 1 leaves: the fetch finishes first, the leave clears.
    const slow = t2.adapter.connect.identity({ refresh: true });
    await sleep(2);
    await t1.adapter.connect.leave();
    await slow;
    expect(await t1.adapter.connect.current()).toBeNull();
    expect(await t2.adapter.connect.current()).toBeNull();
  });

  it("keep a stale K_disc stale and never roll a roster back", async () => {
    undo = installLocks();
    const t1 = await adapterWorld();
    const t2 = await adapterWorld(true, t1);
    await t1.adapter.connect.identity();
    const src2 = t2.adapter.connect.relaySource();
    // Tab 2 adopts a pushed roster that dropped a device: K_disc is stale for both tabs.
    expect(await src2.adoptRing!(await t1.worker.ring(2, false))).toEqual({
      stored: true,
      epoch: 2,
    });
    expect(await t1.adapter.connect.discoveryKeys()).toBeNull();
    // Tab 1 asks the Worker, which is still on epoch 1: refused as stale; nothing was rolled back.
    await expect(t1.adapter.connect.identity()).rejects.toMatchObject({
      code: "peer-cert-invalid",
    });
    expect(await t1.adapter.connect.discoveryKeys()).toBeNull();
    // A later push of the same roster in either tab cannot clear the mark.
    expect(
      await t1.adapter.connect.relaySource().adoptRing!(
        await t1.worker.ring(3, false),
      ),
    ).toEqual({ stored: true, epoch: 3 });
    expect(await t2.adapter.connect.discoveryKeys()).toBeNull();
    // Only an identity fetch at the same or a higher epoch brings keys back.
    t1.worker.epoch = 3;
    t1.worker.withOther = false;
    await t2.adapter.connect.identity({ refresh: true });
    expect(await t1.adapter.connect.discoveryKeys()).not.toBeNull();
  });

  it("hold the relay socket in one tab; the other reports elsewhere and takes over when it stops", async () => {
    undo = installLocks();
    const t1 = await adapterWorld();
    const t2 = await adapterWorld(true, t1);
    const room = new FakeRoom();
    room.members.add(ME);
    const sock = (url: string, protocols: string[]): RelaySocket => {
      room.tickets.set(protocols[1]!, ME);
      return room.webSocket(url, protocols);
    };
    const opts = { relay: { webSocket: sock, timer: new ManualTimer().timer } };
    await t1.adapter.cloudConnect.start(opts);
    await until(() => t1.adapter.cloudConnect.status().relay === "open");
    await t2.adapter.cloudConnect.start(opts);
    expect(t2.adapter.cloudConnect.status().relay).toBe("elsewhere");
    await sleep(30);
    expect(room.made).toHaveLength(1);
    await t1.adapter.cloudConnect.stop();
    await until(() => t2.adapter.cloudConnect.status().relay === "open");
    expect(room.made).toHaveLength(2);
    await t2.adapter.cloudConnect.stop();
  });

  it("run transfers in the tab that owns the relay only; another tab's send is the typed elsewhere (CC-20.4)", async () => {
    undo = installLocks();
    const t1 = await adapterWorld();
    const t2 = await adapterWorld(true, t1);
    const room = new FakeRoom();
    room.members.add(ME);
    const sock = (url: string, protocols: string[]): RelaySocket => {
      room.tickets.set(protocols[1]!, ME);
      return room.webSocket(url, protocols);
    };
    const opts = { relay: { webSocket: sock, timer: new ManualTimer().timer } };
    await t1.adapter.cloudConnect.start(opts);
    await until(() => t1.adapter.cloudConnect.status().relay === "open");
    await t2.adapter.cloudConnect.start(opts);
    const err = await t2.adapter.cloudConnect.transfer
      .send(B, new Blob(["x"]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LanError);
    expect(err).toMatchObject({
      reason: "elsewhere",
      code: "connect-unavailable",
    });
    await t1.adapter.cloudConnect.stop();
    await t2.adapter.cloudConnect.stop();
  });
});

// ── Aggregate bounds, an unreachable relay, inbound sessions (R-6w) ───────────────────────────

describe("bounds and the unreachable relay", () => {
  it("closes a session whose bytes would pass the budget shared by every session", async () => {
    const w = await world();
    const ta = new ManualTimer();
    const tb = new ManualTimer();
    const ra = await w.svc(w.a, ta, { queueBudgetBytes: 1_500_000 });
    const rb = await w.svc(w.b, tb);
    const inn: ConnectSession[] = [];
    ra.onSession((s) => inn.push(s));
    await ra.ready();
    await rb.ready();
    await until(() => rb.members().includes(A));
    const o1 = await rb.dial(A);
    const o2 = await rb.dial(A);
    await until(() => inn.length === 2);
    await o1.send(new Uint8Array(1_000_000));
    await sleep(60);
    expect(inn.every((s) => s.closed === null)).toBe(true);
    await o2.send(new Uint8Array(1_000_000));
    await until(() => inn.some((s) => s.closed !== null));
    const closed = inn.filter((s) => s.closed !== null);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.closed!.code).toBe("peer_busy");
  });

  it("closes the socket 1013 when received envelopes pile up unhandled", async () => {
    const w = await world();
    const id = await w.identity(w.a);
    let open!: () => void;
    const gate = new Promise<void>((r) => (open = r));
    const r = await w.svc(
      w.a,
      new ManualTimer(),
      { maxPendingBytes: 100_000 },
      { load: async () => (await gate, id) },
    );
    await r.ready();
    const sock = w.room.made[0]!;
    for (let i = 0; i < 3; i += 1)
      w.room.inject(B, A, i + 1, new Uint8Array(60_000).fill(1));
    await until(() => sock.closeCode === 1013);
    open();
  });

  it("reports unavailable after five never-opened attempts, points at CSP, and slows to 5 minutes", async () => {
    const w = await world();
    const t = new ManualTimer();
    const r = await w.svc(
      w.a,
      t,
      {},
      {
        // A ticket the room does not know: the socket is shut and never opens, as a CSP block does.
        ticket: async () => ({
          ticket: `pkeyrt_${b64(randomBytes(24))}`,
          url: `wss://key.plrs.im/${PRODUCT}/connect/relay`,
          protocol: "pkey-relay.1",
          expiresAt: T0 + 60,
        }),
      },
    );
    const backoffs = () => t.delays.filter(isBackoff);
    for (let i = 1; i <= 5; i += 1) {
      await until(() => backoffs().length === i);
      if (i < 5) {
        expect(r.status.error?.reason).not.toBe("unavailable");
        t.fire(isBackoff);
      }
    }
    expect(r.status.error).toMatchObject({
      reason: "unavailable",
      code: "network-error",
    });
    expect(r.status.error!.message).toContain("connect-src wss://");
    expect(backoffs()[4]).toBe(300_000);
  });

  it("closes an inbound session at once when nothing listens to onChannel", async () => {
    const w = await world();
    const { CloudConnect } =
      await import("@polaris-key/ui-core/browser/sdk/browser/connect/cloud.js");
    const ta = new ManualTimer();
    const tb = new ManualTimer();
    let listening = false;
    const connect = {
      lockName: "pkey-connect:test",
      identity: async () => ({ deviceId: A }),
      relaySource: () => ({}) as RelaySource,
      listDevices: async () => [],
    };
    const src = await w.source(w.a);
    connect.relaySource = () => src;
    const cc = new CloudConnect(connect as never, {
      channel: () => listening,
      notice: () => undefined,
      change: () => undefined,
    });
    await cc.start({
      relay: {
        webSocket: w.room.webSocket,
        timer: ta.timer,
        caps: ["app/1"],
      },
    });
    const rb = await w.svc(w.b, tb, { caps: ["app/1"] });
    await rb.ready();
    await until(() => rb.members().includes(A));
    const out = await rb.dial(A);
    await until(() => out.closed !== null);
    // With a listener the session stays.
    listening = true;
    const kept = await rb.dial(A);
    await sleep(80);
    expect(kept.closed).toBeNull();
    await cc.stop();
  });
});

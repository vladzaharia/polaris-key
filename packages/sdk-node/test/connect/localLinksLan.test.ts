// @pkey-feature connect.local
// Local links after the pairing, mode `l` (CC-29.8; WIRE-CONTRACT-V5 §15.5 "One listener, one
// order", §15.12 "Mode l" and "Gates"): two clients with no account pair by a code, mark the link
// reachable, find each other by the `m=l` advert on an in-process mDNS network and open sessions
// over loopback. The listener runs with no account; with one it is the shared listener. The
// codecs, the pin, the trial order and the gate predicate are the `peer-matrix.json` `local` rows
// (conformance/runners/node); this file covers what the Node SDK does with them.
import { readFileSync, readdirSync } from "node:fs";
import { connect as tcp } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeFrame } from "@polaris-key/client-core/peer";
import type { PolarisKeyClient } from "../../src/client.js";
import type {
  ConnectSession,
  IncomingOffer,
  LocalOffer,
  LocalPairHandle,
} from "../../src/connect/index.js";
import { ErrorCode } from "../../src/constants.generated.js";
import { LanService } from "../../src/connect/lan.js";
import { resetLocalBudgets } from "../../src/connect/localLinks.js";
import { LOCAL_STATE_FILE, localTag } from "../../src/connect/localState.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  endTest,
  T0,
  freezeAtT0,
  makeClient,
  text,
  tmpDir,
  until,
  utf8,
} from "../lanFixtures.js";

// A dial can be held at the door: a test makes the reload happen while the socket is opening.
const door = vi.hoisted(() => ({
  hold: null as Promise<void> | null,
  waiting: 0,
}));
vi.mock("../../src/connect/dial.js", async (orig) => {
  const real = await orig<typeof import("../../src/connect/dial.js")>();
  return {
    ...real,
    dialRaceTo: async (...a: Parameters<typeof real.dialRaceTo>) => {
      if (door.hold !== null) {
        door.waiting++;
        await door.hold;
      }
      return real.dialRaceTo(...a);
    },
  };
});

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

let handles: LocalPairHandle[] = [];
let clients: PolarisKeyClient[] = [];
let dirs: string[] = [];

beforeEach(() => {
  door.hold = null;
  door.waiting = 0;
  resetLocalBudgets();
  freezeAtT0();
});
afterEach(() => endTest({ clients, dirs, stoppables: handles }));

const content = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (7 * i + 13) % 256);

/** Device A (signed in or not) and device B (no credential): discovery says pairing is on. */
async function world(o: { gate?: boolean; accountA?: boolean } = {}) {
  const worker = new MultiWorker();
  worker.localPairing = o.gate ?? true;
  const a = await makeClient(worker, "1", dirs, {
    noToken: o.accountA !== true,
  });
  const b = await makeClient(worker, "2", dirs, { noToken: true });
  clients.push(a, b);
  await a.discover();
  await b.discover();
  if (o.accountA === true) await a.connect.identity();
  // The listeners each client starts, so a test can reach the service under `cloudConnect`.
  const lans = { a: [] as LanService[], b: [] as LanService[] };
  for (const [c, list] of [
    [a, lans.a],
    [b, lans.b],
  ] as const) {
    const orig = c.connect.lanLocal.bind(c.connect);
    c.connect.lanLocal = async (opts) => {
      const l = await orig(opts);
      list.push(l);
      return l;
    };
  }
  return { worker, a, b, net: new MemoryMdnsNetwork(), lans };
}
type World = Awaited<ReturnType<typeof world>>;

/** Pair A (shows, "Ana") and B (joins, "Bo"); each side lists the id it holds for the other. */
async function pair(
  w: World,
  catsA = ["photos", "notes"],
  catsB = ["notes", "docs"],
): Promise<{ idOfB: string; idOfA: string }> {
  const offersA: LocalOffer[] = [];
  const offersB: LocalOffer[] = [];
  let code = "";
  const h = await w.a.cloudConnect.localLinks.pair({
    categories: catsA,
    label: "Ana",
    mdns: w.net.adapter(),
    ...LOOP,
    onCode: (c) => (code = c.code),
    onConfirm: (o) => offersA.push(o),
  });
  handles.push(h);
  const joined = w.b.cloudConnect.localLinks.join({
    categories: catsB,
    label: "Bo",
    code,
    mdns: w.net.adapter(),
    ...LOOP,
    onConfirm: (o) => offersB.push(o),
  });
  await until(() => offersA.length === 1 && offersB.length === 1);
  await Promise.all([offersA[0]!.confirm(), offersB[0]!.confirm()]);
  const mine = await joined;
  await until(
    async () => (await w.a.cloudConnect.localLinks.list()).length === 1,
  );
  return {
    idOfA: mine.id,
    idOfB: (await w.a.cloudConnect.localLinks.list())[0]!.id,
  };
}

const startLan = (c: PolarisKeyClient, net: MemoryMdnsNetwork) =>
  c.cloudConnect.start({
    lan: { mdns: net.adapter(), ...LOOP },
    relay: false,
  });

const lAdverts = (net: MemoryMdnsNetwork) =>
  [...net.adverts.values()].filter((a) => a.txt.includes("m=l"));

/** A world with the link made, both ends marked reachable and both listeners up. */
async function ready(o: { accountA?: boolean } = {}) {
  const w = await world(o);
  const ids = await pair(w);
  await startLan(w.a, w.net);
  await startLan(w.b, w.net);
  await w.a.cloudConnect.localLinks.setReachable(ids.idOfB, true);
  await w.b.cloudConnect.localLinks.setReachable(ids.idOfA, true);
  await until(() => lAdverts(w.net).length === 2);
  const inbound: ConnectSession[] = [];
  w.a.cloudConnect.localLinks.onLink((s) => inbound.push(s));
  return { ...w, ...ids, inbound, out: tmpDir(dirs) };
}
type Ready = Awaited<ReturnType<typeof ready>>;

/** A session from `c` to the peer of `id`, retrying until the peer's advert has been seen. */
async function openTo(
  c: PolarisKeyClient,
  id: string,
): Promise<ConnectSession> {
  let s: ConnectSession | null = null;
  await until(async () => {
    try {
      s = await c.cloudConnect.localLinks.open(id);
      return true;
    } catch (e) {
      if ((e as { reason?: string }).reason !== "unknown_peer") throw e;
      return false;
    }
  });
  return s!;
}

/** B opens a session to A. */
const openB = (w: Ready): Promise<ConnectSession> => openTo(w.b, w.idOfA);

/** The state directory of a client, where the local-link record lives. */
const stateOf = (c: PolarisKeyClient): string =>
  (c as unknown as { core: { dirs: { state: string } } }).core.dirs.state;

describe("a local link after the pairing, with no account", () => {
  it("advertises m=l only for reachable links, opens a session both ways and delivers it to onLink", async () => {
    const w = await world();
    const { idOfA, idOfB } = await pair(w);
    // With no account `start()` brings up the listener for local links alone.
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    expect(w.a.cloudConnect.status()).toMatchObject({
      running: true,
      lan: "on",
      relay: "off",
    });
    // A new link is reachable by default (§15.12): both are advertised, and the list says so.
    await until(() => lAdverts(w.net).length === 2);
    expect(
      (await w.a.cloudConnect.localLinks.list()).map((l) => l.reachable),
    ).toEqual([true]);
    expect(await w.a.cloudConnect.localLinks.setReachable("nope", true)).toBe(
      false,
    );
    // Off withdraws that device's advert; on brings it back.
    expect(await w.a.cloudConnect.localLinks.setReachable(idOfB, false)).toBe(
      true,
    );
    await until(() => lAdverts(w.net).length === 1);
    expect(await w.a.cloudConnect.localLinks.setReachable(idOfB, true)).toBe(
      true,
    );
    await until(() => lAdverts(w.net).length === 2);
    // No account advert, no product tag, no nameplate: `v=1` and `m=l`, and nothing else.
    expect([...w.net.adverts.values()].map((a) => a.txt)).toEqual([
      ["v=1", "m=l"],
      ["v=1", "m=l"],
    ]);
    expect(
      [...w.net.adverts.values()].every((a) =>
        /^p1-[a-z2-7]{16}$/.test(a.instance),
      ),
    ).toBe(true);

    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.localLinks.onLink((s) => inbound.push(s));
    const s = await openTo(w.b, idOfA);
    await until(() => inbound.length === 1);
    // Each end shows the label it stored; the categories are the ones both approved.
    expect(s.local).toMatchObject({
      id: idOfA,
      label: "Ana",
      categories: ["notes"],
    });
    expect(inbound[0]!.local).toMatchObject({
      id: idOfB,
      label: "Bo",
      categories: ["notes"],
    });
    expect(s.role).toBe("initiator");
    expect(inbound[0]!.role).toBe("responder");
    await s.send(utf8("hello"));
    expect(text((await inbound[0]!.receive()).body)).toBe("hello");
    await inbound[0]!.send(utf8("back"));
    expect(text((await s.receive()).body)).toBe("back");
    // The link was used: its last-seen time moved.
    await until(
      async () =>
        (await w.a.cloudConnect.localLinks.list())[0]!.lastSeen !== null,
    );
    // Unmarking withdraws the advert.
    await w.a.cloudConnect.localLinks.setReachable(idOfB, false);
    await until(() => lAdverts(w.net).length === 1);
  });

  it("answers the typed N/A while the gate is off, withdraws and ends sessions when a read clears it, and resumes when it is on again", async () => {
    const w = await ready();
    const s = await openB(w);
    await until(() => w.inbound.length === 1);
    const closes: { code: string; byPeer: boolean }[] = [];
    w.inbound[0]!.onClose((c) => closes.push(c));

    w.worker.localPairing = false;
    await w.a.discover();
    // The adverts of this device go, its open session ends `peer_bye`, the link stays on disk.
    await until(() => lAdverts(w.net).length === 1);
    await until(() => closes.length === 1);
    expect(closes[0]).toEqual({ code: "peer_bye", byPeer: false });
    await expect(
      w.a.cloudConnect.localLinks.open(w.idOfB),
    ).rejects.toMatchObject({ code: "local-pairing-off" });
    expect(await w.a.cloudConnect.localLinks.list()).toHaveLength(1);
    // Managing links is never gated.
    expect(await w.a.cloudConnect.localLinks.rename(w.idOfB, "Bob")).toBe(true);
    // The other device finds a listener that serves nothing.
    s.onClose(() => undefined);
    await expect(
      w.b.cloudConnect.localLinks.open(w.idOfA),
    ).rejects.toBeDefined();

    w.worker.localPairing = true;
    await w.a.discover();
    await until(() => lAdverts(w.net).length === 2);
    const again = await openB(w);
    expect(again.local?.id).toBe(w.idOfA);
  });

  it("forgetting a link ends its session peer_revoked, deletes its keys and closes the way in", async () => {
    const w = await ready();
    const s = await openB(w);
    await until(() => w.inbound.length === 1);
    const theirs: { code: string; byPeer: boolean }[] = [];
    s.onClose((c) => theirs.push(c));
    const mine: { code: string; byPeer: boolean }[] = [];
    w.inbound[0]!.onClose((c) => mine.push(c));
    const file = join(stateOf(w.a), LOCAL_STATE_FILE);
    const secret = (
      JSON.parse(readFileSync(file, "utf8")) as { links: { secret: string }[] }
    ).links[0]!.secret;

    expect(await w.a.cloudConnect.localLinks.remove(w.idOfB)).toBe(true);
    expect(await w.a.cloudConnect.localLinks.remove(w.idOfB)).toBe(false);
    await until(() => mine.length === 1 && theirs.length === 1);
    expect(mine[0]).toEqual({ code: "peer_revoked", byPeer: false });
    expect(theirs[0]).toEqual({ code: "peer_revoked", byPeer: true });
    expect(await w.a.cloudConnect.localLinks.list()).toEqual([]);
    expect(readFileSync(file, "utf8")).not.toContain(secret);
    // Its advert is gone, and the other device's secret opens nothing here.
    await until(() => lAdverts(w.net).length === 1);
    await expect(
      w.b.cloudConnect.localLinks.open(w.idOfA),
    ).rejects.toBeDefined();
    // The other device still holds its half: "Not reachable", and its person can forget it too.
    expect(await w.b.cloudConnect.localLinks.list()).toHaveLength(1);
  });

  it("renames on this device only", async () => {
    const w = await ready();
    expect(await w.a.cloudConnect.localLinks.rename("nope", "X")).toBe(false);
    await expect(
      w.a.cloudConnect.localLinks.rename(w.idOfB, "   "),
    ).rejects.toMatchObject({ reason: "bad_input" });
    expect(await w.a.cloudConnect.localLinks.rename(w.idOfB, " Bob ")).toBe(
      true,
    );
    expect((await w.a.cloudConnect.localLinks.list())[0]!.label).toBe("Bob");
    expect((await w.b.cloudConnect.localLinks.list())[0]!.label).toBe("Ana");
    await openB(w);
    await until(() => w.inbound.length === 1);
    // The host shows the stored label, not the peer's HELLO (which this peer left empty).
    expect(w.inbound[0]!.local?.label).toBe("Bob");
    expect(w.inbound[0]!.hello.label).toBeUndefined();
  });

  it("carries Direct Transfer: the link's categories decide, and the offer names a local link", async () => {
    const w = await ready();
    const offers: IncomingOffer[] = [];
    w.a.cloudConnect.transfer.onOffer((o) => {
      offers.push(o);
      return { saveTo: join(w.out, "n.bin") };
    });
    const sendTo = (id: string, category: string | undefined, bytes: number) =>
      w.b.cloudConnect.transfer.send({ link: id }, content(bytes), {
        name: "note",
        ...(category !== undefined ? { category } : {}),
      });
    // The link is found by its advert: the first send is retried until then.
    await until(() =>
      sendTo(w.idOfA, "notes", 90_000).then(
        () => true,
        (e: { reason?: string }) => {
          if (e.reason === "unknown_peer") return false;
          throw e;
        },
      ),
    );
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      category: "notes",
      from: { kind: "local", linkId: w.idOfB, label: "Bo" },
      path: "lan",
    });
    expect(readdirSync(w.out)).toEqual(["n.bin"]);
    // `docs` was approved by Bo only; no category is no approval either: refused before asking.
    const refused = await Promise.all(
      ["docs", "photos", undefined].map((c) =>
        sendTo(w.idOfA, c, 10).then(
          () => null,
          (e: { code: string; reason: string }) => e,
        ),
      ),
    );
    expect(refused.map((e) => [e?.code, e?.reason])).toEqual(
      Array(3).fill(["transfer-cancelled", "category"]),
    );
    expect(offers).toHaveLength(1);
    await expect(sendTo("x".repeat(16), "notes", 1)).rejects.toMatchObject({
      code: "link-unknown",
    });
  });

  it("the shared listener serves an account and a local link; a sign-out leaves the link reachable", async () => {
    const w = await ready({ accountA: true });
    // A is signed in: its listener is the shared one (account keys first, then the local links).
    expect([...w.net.adverts.values()].some((a) => a.txt.includes("m=a"))).toBe(
      true,
    );
    const s = await openB(w);
    await until(() => w.inbound.length === 1);
    expect(w.inbound[0]!.local?.id).toBe(w.idOfB);
    await s.close();

    await w.a.cloudConnect.stopForSignOut();
    // The account half went; the listener is back up for the local link alone.
    expect(w.a.cloudConnect.status()).toMatchObject({
      running: true,
      lan: "on",
    });
    await until(
      () =>
        ![...w.net.adverts.values()].some((a) => a.txt.includes("m=a")) &&
        lAdverts(w.net).length === 2,
    );
    const again = await openB(w);
    expect(again.local?.id).toBe(w.idOfA);
    await until(() => w.inbound.length === 2);
  });

  it("start with no account and the gate off is still the no-token error", async () => {
    const w = await world({ gate: false });
    await expect(startLan(w.a, w.net)).rejects.toMatchObject({
      code: "no-token",
    });
    expect(w.a.cloudConnect.status().running).toBe(false);
  });
});

const links = (c: PolarisKeyClient) => c.cloudConnect.localLinks;
const lastLan = (l: LanService[]): LanService => l[l.length - 1]!;
const rnd32 = (): Uint8Array => crypto.getRandomValues(new Uint8Array(32));

describe("who the listener answers", () => {
  it("a source group that sends junk is refused after two, and a link's own sessions are never counted against it", async () => {
    const w = await ready();
    // Three sessions in a row from one source group: a session that opens is not counted.
    for (let i = 0; i < 3; i++) {
      const s = await openB(w);
      await until(() => w.inbound.length === i + 1);
      await s.close();
      // The one dial per link is repeated at once only after a success; no cooldown applies.
    }
    // Two junk message 1s from the same group spend its budget; the third dial is refused before
    // any secret is tried, so the real peer's handshake closes without a session.
    const port = [...w.net.adverts.values()][0]!.port;
    const junk = (): Promise<void> =>
      new Promise((done) => {
        const sock = tcp({ host: "127.0.0.1", port });
        sock.on("error", () => undefined);
        sock.on("close", () => done());
        sock.write(encodeFrame(rnd32().subarray(0, 32)));
        sock.write(encodeFrame(new Uint8Array(96)));
      });
    // Whichever listener the first advert is, the junk goes to a listener that holds the link.
    const target = [...w.net.adverts.values()][0]!.port;
    expect([lastLan(w.lans.a).port, lastLan(w.lans.b).port]).toContain(target);
    await junk();
    await junk();
    const owner = lastLan(w.lans.a).port === target ? w.a : w.b;
    const peer = owner === w.a ? w.b : w.a;
    const peerLink = owner === w.a ? w.idOfA : w.idOfB;
    const sessions: ConnectSession[] = [];
    links(owner).onLink((s) => sessions.push(s));
    await expect(
      (async () => {
        // The peer must find the owner first; then its handshake is refused.
        await until(async () => {
          try {
            await links(peer).open(peerLink);
            return true;
          } catch (e) {
            if ((e as { reason?: string }).reason === "unknown_peer")
              return false;
            throw e;
          }
        });
      })(),
    ).rejects.toMatchObject({ code: ErrorCode.peerCertInvalid });
    expect(sessions).toHaveLength(0);
  });
});

describe("reachable by default and the cap of eight (§15.12)", () => {
  it("a new link is reachable; the ninth reachable link is refused with local-links-full and stored off", async () => {
    const w = await world();
    const store = w.a.connect.localStore();
    const add = (n: number) =>
      store.add({
        ownKey: rnd32(),
        ownPublic: rnd32(),
        peerKey: rnd32(),
        secret: rnd32(),
        label: `p${n}`,
        cats: [],
        now: T0,
      });
    for (let n = 0; n < 9; n++) expect((await add(n)).stored).toBe(true);
    const list = await links(w.a).list();
    expect(list.map((l) => l.reachable)).toEqual([
      ...Array(8).fill(true),
      false,
    ]);
    const ninth = list[8]!.id;
    await expect(links(w.a).setReachable(ninth, true)).rejects.toMatchObject({
      code: ErrorCode.localLinksFull,
    });
    expect((await links(w.a).list())[8]!.reachable).toBe(false);
    // Turning one off makes room; turning an already reachable one on is not refused.
    expect(await links(w.a).setReachable(list[0]!.id, false)).toBe(true);
    expect(await links(w.a).setReachable(ninth, true)).toBe(true);
    expect(await links(w.a).setReachable(list[1]!.id, true)).toBe(true);
    expect((await links(w.a).list()).filter((l) => l.reachable)).toHaveLength(
      8,
    );
  });
});

describe("no listener until a link is held", () => {
  it("start() with no link binds nothing; the first pairing brings the listener up and forgetting the last takes it down", async () => {
    const w = await world();
    await startLan(w.a, w.net);
    expect(w.a.cloudConnect.status()).toMatchObject({
      running: true,
      lan: "off",
    });
    expect(w.lans.a).toHaveLength(0);
    const { idOfB } = await pair(w);
    await until(() => w.a.cloudConnect.status().lan === "on");
    await until(() => lAdverts(w.net).length === 1);
    expect(await links(w.a).remove(idOfB)).toBe(true);
    await until(() => w.a.cloudConnect.status().lan === "off");
    await until(() => lAdverts(w.net).length === 0);
    // Still started: a link made later brings it up again.
    expect(w.a.cloudConnect.status().running).toBe(true);
  });
});

describe("the gate is read again while it is on", () => {
  it("every 1 to 4 hours, with jitter: a withdrawal reaches an idle host", async () => {
    const w = await world();
    const gate = w.a as unknown as { localRereadMs: () => number };
    const spy = vi.spyOn(Math, "random");
    spy.mockReturnValue(0);
    expect(gate.localRereadMs()).toBe(3_600_000);
    spy.mockReturnValue(0.999999);
    expect(gate.localRereadMs()).toBeLessThan(4 * 3_600_000);
    expect(gate.localRereadMs()).toBeGreaterThan(3.99 * 3_600_000);
    spy.mockRestore();

    gate.localRereadMs = () => 2 * 3_600_000;
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0 * 1000);
    await w.a.discover();
    expect(links(w.a).localPairing()).toBe(true);
    w.worker.localPairing = false;
    await vi.advanceTimersByTimeAsync(2 * 3_600_000 - 1000);
    expect(links(w.a).localPairing()).toBe(true);
    await vi.advanceTimersByTimeAsync(2000);
    expect(links(w.a).localPairing()).toBe(false);
  });
});

describe("last seen", () => {
  it("is written at most once an hour, coarsened to the hour", async () => {
    const w = await world();
    await pair(w);
    const row = (await w.a.connect.localStore().rows())[0]!;
    const ref = {
      id: row.id,
      label: null,
      categories: [],
      peerKey: row.peerKey,
      tag: localTag(Buffer.from(row.secret, "base64url")),
    };
    const seen = async () => (await links(w.a).list())[0]!.lastSeen;
    expect(await seen()).toBeNull();
    const hour = Math.floor(T0 / 3600) * 3600;
    vi.setSystemTime((hour + 1234) * 1000);
    await w.a.connect.touchLocal(ref);
    expect(await seen()).toBe(hour);
    // Later in the same hour: nothing changes.
    vi.setSystemTime((hour + 3500) * 1000);
    await w.a.connect.touchLocal(ref);
    expect(await seen()).toBe(hour);
    vi.setSystemTime((hour + 3600 + 5) * 1000);
    await w.a.connect.touchLocal(ref);
    expect(await seen()).toBe(hour + 3600);
  });
});

describe("a link is used only while it is held", () => {
  it("a reload while the dial is in flight does not break the handshake", async () => {
    const w = await ready();
    await until(() => lastLan(w.lans.b).localPeers().length === 1);
    let release!: () => void;
    door.hold = new Promise<void>((r) => (release = r));
    const opening = links(w.b).open(w.idOfA);
    await until(() => door.waiting === 1);
    // The reload wipes the secrets the listener held when the dial began.
    await lastLan(w.lans.b).refreshContacts();
    door.hold = null;
    release();
    const s = await opening;
    expect(s.local?.id).toBe(w.idOfA);
  });

  it("after await remove(), a dial to that link fails at once", async () => {
    const w = await ready();
    // A second link keeps the listener up (with none left it closes).
    await w.a.connect.localStore().add({
      ownKey: rnd32(),
      ownPublic: rnd32(),
      peerKey: rnd32(),
      secret: rnd32(),
      cats: [],
      now: T0,
    });
    await until(() => lastLan(w.lans.a).localPeers().length === 1);
    expect(await links(w.a).remove(w.idOfB)).toBe(true);
    await expect(lastLan(w.lans.a).connectLocal(w.idOfB)).rejects.toMatchObject(
      { reason: "unknown_peer" },
    );
  });

  it("a session delivered to no handler is ended peer_bye, not left open and untracked", async () => {
    const w = await world();
    const { idOfA } = await pair(w);
    // A's service has no `LocalLinks` attached: nobody to hand the session to.
    const bare = await w.a.connect.lanLocal({ mdns: w.net.adapter(), ...LOOP });
    try {
      await startLan(w.b, w.net);
      const s = await openTo(w.b, idOfA);
      const closes: { code: string; byPeer: boolean }[] = [];
      s.onClose((c) => closes.push(c));
      await until(() => closes.length === 1);
      expect(closes[0]).toEqual({ code: "peer_bye", byPeer: true });
    } finally {
      await bare.stop();
    }
  });

  it("attach waits for the previous attach's sessions to end, and keeps the sessions made after", async () => {
    const w = await ready();
    const s1 = await openB(w);
    await until(() => w.inbound.length === 1);
    const ended: { code: string; byPeer: boolean }[] = [];
    w.inbound[0]!.onClose((c) => ended.push(c));
    await links(w.a).attach(lastLan(w.lans.a));
    expect(ended).toEqual([{ code: "peer_bye", byPeer: false }]);
    await s1.close().catch(() => undefined);
    const s2 = await openB(w);
    await until(() => w.inbound.length === 2);
    const closes: { code: string }[] = [];
    w.inbound[1]!.onClose((c) => closes.push(c));
    // The session is tracked: forgetting its link ends it.
    await links(w.a).remove(w.idOfB);
    await until(() => closes.length === 1);
    expect(closes[0]).toEqual({ code: "peer_revoked", byPeer: false });
    await s2.close().catch(() => undefined);
  });

  it("a gate that moved while the service was starting is applied: the adverts are withdrawn", async () => {
    for (const notify of [true, false]) {
      const w = await world();
      await pair(w);
      let on = true;
      const base = w.net.adapter();
      const mdns = {
        ...base,
        advertise: async (a: Parameters<typeof base.advertise>[0]) => {
          const h = await base.advertise(a);
          on = false;
          if (notify) w.a.connect.notifyLocals();
          return h;
        },
      };
      const lan = await LanService.startLocal(
        { ...w.a.connect.lanSource(), localAllowed: () => on },
        { mdns, ...LOOP },
      );
      try {
        await until(() => lAdverts(w.net).length === 0);
      } finally {
        await lan.stop();
      }
      await endTest({ clients, dirs, stoppables: handles });
      freezeAtT0();
    }
  });

  it("a fault while a connection is accepted ends that socket and the listener keeps serving", async () => {
    const w = await world();
    await pair(w);
    let boom = false;
    const lan = await LanService.startLocal(
      {
        ...w.a.connect.lanSource(),
        localAllowed: () => {
          if (boom) throw new Error("fault");
          return true;
        },
      },
      { mdns: w.net.adapter(), ...LOOP },
    );
    try {
      boom = true;
      const closed = await new Promise<boolean>((done) => {
        const sock = tcp({ host: "127.0.0.1", port: lan.port });
        sock.on("error", () => undefined);
        sock.on("close", () => done(true));
      });
      expect(closed).toBe(true);
      boom = false;
      const up = await new Promise<boolean>((done) => {
        const sock = tcp({ host: "127.0.0.1", port: lan.port });
        sock.on("error", () => done(false));
        sock.on("connect", () => {
          sock.destroy();
          done(true);
        });
      });
      expect(up).toBe(true);
    } finally {
      await lan.stop();
    }
  });
});

// @pkey-feature connect.links
// Inter-account links, end to end in one process (CC-19.5; WIRE-CONTRACT-V5 §15.10): two clients
// of two accounts on 127.0.0.1 open pairing on an in-process mDNS network, run mode `p` to the
// code, confirm it, and hold a link. They then find each other under the `m=c` advert and open a
// mode-`c` session on the LAN, and through an in-process contact room. The gate, the pin, the
// revocation and the pending contact are covered here; the codecs and the cap are the
// `peer-matrix.json` `contact` rows (conformance/runners/node).
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { Socket } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnsupportedError } from "@polaris-key/client-core";
import { base64UrlDecode, base64UrlEncodeBytes } from "@polaris-key/jws";
import { promoteRow, secretTag } from "../../src/connect/contacts.js";
import type { PolarisKeyClient } from "../../src/client.js";
import {
  LanError,
  RelayError,
  CloudLinks,
  contactId,
  type ConnectSession,
  type LinkOffer,
  type LinkPairHandle,
  type PairedLink,
} from "../../src/connect/index.js";
import { CONNECT_STATE_FILE } from "../../src/connect/state.js";
import { FakeContactRooms } from "../contactFixtures.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  T0,
  devId,
  makeClient,
  text,
  until,
  utf8,
} from "../lanFixtures.js";

const B = devId("2");
const SUB_B = "ps_BBBBBBBBBBBBBBBBBBBBBB";
const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

let dirs: string[] = [];
let clients: PolarisKeyClient[] = [];
let handles: LinkPairHandle[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0 * 1000);
});
afterEach(async () => {
  await Promise.all(
    handles.splice(0).map((h) => h.stop().catch(() => undefined)),
  );
  await Promise.all(
    clients.map((c) => c.cloudConnect.stop().catch(() => undefined)),
  );
  for (const c of clients.splice(0)) c.close();
  vi.useRealTimers();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Two devices of two accounts, both with a discovery that says links are on. */
async function world(interAccount = true) {
  const worker = new MultiWorker();
  worker.interAccount = interAccount;
  worker.subs.set(B, SUB_B);
  const a = await makeClient(worker, "1", dirs);
  const b = await makeClient(worker, "2", dirs);
  clients.push(a, b);
  await a.discover();
  await b.discover();
  await a.connect.identity();
  await b.connect.identity();
  return {
    worker,
    a,
    b,
    net: new MemoryMdnsNetwork(),
    rooms: new FakeContactRooms(worker),
  };
}

interface Side {
  offers: LinkOffer[];
  linked: PairedLink[];
  failed: string[];
  handle: LinkPairHandle;
}

async function openPairing(
  c: PolarisKeyClient,
  net: MemoryMdnsNetwork,
  categories: string[],
  label: string,
): Promise<Side> {
  const side: Side = {
    offers: [],
    linked: [],
    failed: [],
    handle: undefined as unknown as LinkPairHandle,
  };
  side.handle = await c.cloudConnect.links.pair({
    categories,
    label,
    mdns: net.adapter(),
    ...LOOP,
    onCode: (o) => side.offers.push(o),
    onLinked: (l) => side.linked.push(l),
    onFailed: (f) => side.failed.push(f.reason),
  });
  handles.push(side.handle);
  return side;
}

/** Pair the two devices and return the id each holds for the other. */
async function link(
  w: Awaited<ReturnType<typeof world>>,
  catsA = ["photos", "notes"],
  catsB = ["notes", "docs"],
): Promise<{ idOfB: string; idOfA: string }> {
  const sa = await openPairing(w.a, w.net, catsA, "Ana");
  const sb = await openPairing(w.b, w.net, catsB, "Bo");
  await until(() => sa.offers.length === 1 && sb.offers.length === 1);
  await Promise.all([sa.offers[0]!.confirm(), sb.offers[0]!.confirm()]);
  await until(() => sa.linked.length === 1 && sb.linked.length === 1);
  return { idOfB: sa.linked[0]!.id, idOfA: sb.linked[0]!.id };
}

const startLan = (c: PolarisKeyClient, net: MemoryMdnsNetwork) =>
  c.cloudConnect.start({
    lan: { mdns: net.adapter(), ...LOOP },
    relay: false,
  });

describe("the gate", () => {
  it("pair and open throw the typed N/A while discovery says interAccount false, and nothing is advertised", async () => {
    const w = await world(false);
    expect(w.a.cloudConnect.links.interAccount()).toBe(false);
    await expect(
      w.a.cloudConnect.links.pair({ categories: [], onCode: () => undefined }),
    ).rejects.toMatchObject({
      constructor: UnsupportedError,
      code: "connect_links_disabled",
    });
    await expect(
      w.a.cloudConnect.links.open("x".repeat(16)),
    ).rejects.toBeInstanceOf(UnsupportedError);
    await startLan(w.a, w.net);
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=c")),
    ).toEqual([]);
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=p")),
    ).toEqual([]);
    expect(await w.a.cloudConnect.links.list()).toEqual([]);
  });

  it("rejects categories that break a rule", async () => {
    const w = await world();
    for (const categories of [
      ["Photos"],
      ["a", "a"],
      Array.from({ length: 9 }, (_, i) => `c${i}`),
      ["x".repeat(33)],
    ])
      await expect(
        w.a.cloudConnect.links.pair({ categories, onCode: () => undefined }),
      ).rejects.toBeInstanceOf(LanError);
  });
});

describe("pairing (mode p)", () => {
  it("shows the same code on both screens, then stores a link on both devices", async () => {
    const w = await world();
    const sa = await openPairing(w.a, w.net, ["photos", "notes"], "Ana");
    const sb = await openPairing(w.b, w.net, ["notes", "docs"], "Bo");
    // The adverts: random instance, `v=1`, `m=p` and the product tag; no label, id or key.
    const ps = [...w.net.adverts.values()].filter((a) => a.txt.includes("m=p"));
    expect(ps).toHaveLength(2);
    for (const a of ps) {
      expect(a.instance).toMatch(/^p1-[a-z2-7]{16}$/);
      expect(a.txt).toHaveLength(3);
      expect(a.txt[2]).toMatch(/^h=[0-9a-f]{16}$/);
    }
    await until(() => sa.offers.length === 1 && sb.offers.length === 1);
    expect(sa.offers[0]!.code).toMatch(/^\d{3} \d{3}$/);
    expect(sa.offers[0]!.code).toBe(sb.offers[0]!.code);
    // Display data from the other device, and the categories this app asked for.
    expect(sa.offers[0]!.label).toBe("Bo");
    expect(sb.offers[0]!.label).toBe("Ana");
    expect(sa.offers[0]!.categories).toEqual(["photos", "notes"]);
    // Nothing is stored before both confirm.
    expect(await w.a.cloudConnect.links.list()).toEqual([]);
    await sa.offers[0]!.confirm();
    await new Promise((r) => setTimeout(r, 30));
    expect(await w.a.cloudConnect.links.list()).toEqual([]);
    await sb.offers[0]!.confirm();
    await until(() => sa.linked.length === 1 && sb.linked.length === 1);

    const la = await w.a.cloudConnect.links.list();
    const lb = await w.b.cloudConnect.links.list();
    expect(la).toHaveLength(1);
    expect(la[0]).toMatchObject({
      label: "Bo",
      categories: ["notes"],
      reachable: true,
      rePairPending: false,
    });
    expect(lb[0]).toMatchObject({ label: "Ana", categories: ["notes"] });
    expect(sa.linked[0]).toMatchObject({ id: la[0]!.id, rePair: false });
    // The window is over once the link is made.
    await until(() => !sa.handle.open && !sb.handle.open);
    expect([...w.net.adverts.values()]).toEqual([]);
    // The record holds the secret; the API hands out none of it.
    const raw = readFileSync(
      join(
        (w.a as unknown as { core: { dirs: { state: string } } }).core.dirs
          .state,
        CONNECT_STATE_FILE,
      ),
      "utf8",
    );
    expect(JSON.parse(raw).contacts).toHaveLength(1);
    expect(JSON.stringify(la)).not.toContain(
      JSON.parse(raw).contacts[0].secret,
    );
  });

  it("declining stores nothing on either device and reports it", async () => {
    const w = await world();
    const sa = await openPairing(w.a, w.net, ["x"], "Ana");
    const sb = await openPairing(w.b, w.net, ["x"], "Bo");
    await until(() => sa.offers.length === 1 && sb.offers.length === 1);
    await sa.offers[0]!.decline();
    await until(() => sa.failed.length === 1 && sb.failed.length === 1);
    expect(sa.failed).toEqual(["declined"]);
    expect(sb.failed).toEqual(["closed"]);
    expect(await w.a.cloudConnect.links.list()).toEqual([]);
    expect(await w.b.cloudConnect.links.list()).toEqual([]);
  });

  it("a peer of another product is not dialled", async () => {
    const w = await world();
    const sa = await openPairing(w.a, w.net, ["x"], "Ana");
    w.net.inject({
      instance: "p1-aaaaaaaaaaaaaaaa",
      hosts: ["127.0.0.1"],
      port: 9,
      txt: ["v=1", "m=p", "h=0000000000000000"],
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sa.offers).toEqual([]);
  });
});

describe("mode c on the LAN", () => {
  it("opens a session over the contact advert, both ways, and pins the peer's key", async () => {
    const w = await world();
    const { idOfB, idOfA } = await link(w);
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    // One `m=c` advert per device (each with its own agreeKey in the name), beside the account's.
    const cs = [...w.net.adverts.values()].filter((a) => a.txt.includes("m=c"));
    expect(cs).toHaveLength(2);
    expect(cs[0]!.instance).not.toBe(cs[1]!.instance);
    expect(cs[0]!.txt).toEqual(["v=1", "m=c"]);
    const accounts = [...w.net.adverts.values()].filter((a) =>
      a.txt.includes("m=a"),
    );
    expect(new Set([...cs, ...accounts].map((a) => a.port)).size).toBe(2); // one listener each

    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.links.onLink((s) => inbound.push(s));
    let out!: ConnectSession;
    await until(async () => {
      try {
        out = await w.b.cloudConnect.links.open(idOfA);
        return true;
      } catch {
        return false;
      }
    });
    await until(() => inbound.length === 1);
    expect(out.path).toBe("lan");
    expect(out.contact).toMatchObject({
      id: idOfA,
      label: "Ana",
      categories: ["notes"],
    });
    expect(inbound[0]!.contact).toMatchObject({ id: idOfB, label: "Bo" });
    // A contact session names no device: there is no certificate behind it.
    expect(out.peerDeviceId).toBe("");
    await out.send(utf8("hello across accounts"));
    expect(text((await inbound[0]!.receive()).body)).toBe(
      "hello across accounts",
    );
    await inbound[0]!.send(utf8("and back"));
    expect(text((await out.receive()).body)).toBe("and back");
  });

  it("deleting a contact ends the open session with peer_revoked, and the other side cannot reconnect", async () => {
    const w = await world();
    const { idOfB, idOfA } = await link(w);
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.links.onLink((s) => inbound.push(s));
    let out!: ConnectSession;
    await until(async () => {
      try {
        out = await w.b.cloudConnect.links.open(idOfA);
        return true;
      } catch {
        return false;
      }
    });
    await until(() => inbound.length === 1);
    const closedOut: unknown[] = [];
    const closedIn: unknown[] = [];
    out.onClose((c) => closedOut.push(c));
    inbound[0]!.onClose((c) => closedIn.push(c));
    expect(await w.b.cloudConnect.links.remove(idOfA)).toBe(true);
    expect(await w.b.cloudConnect.links.remove(idOfA)).toBe(false);
    await until(() => closedIn.length === 1 && closedOut.length === 1);
    expect(closedIn[0]).toMatchObject({ code: "peer_revoked", byPeer: true });
    expect(await w.b.cloudConnect.links.list()).toEqual([]);
    await expect(w.b.cloudConnect.links.open(idOfA)).rejects.toMatchObject({
      reason: "unknown_peer",
    });
    // A still holds its side, which no longer opens anything on B: nothing answers.
    expect(await w.a.cloudConnect.links.list()).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 30));
    await expect(w.a.cloudConnect.links.open(idOfB)).rejects.toBeInstanceOf(
      LanError,
    );
    // B no longer advertises the contact.
    expect(
      [...w.net.adverts.values()].filter((a) => a.txt.includes("m=c")),
    ).toHaveLength(1);
  });

  it("a refresh that says interAccount false withdraws the adverts and ends the open contact sessions", async () => {
    const w = await world();
    const { idOfA } = await link(w);
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.links.onLink((s) => inbound.push(s));
    let out!: ConnectSession;
    await until(async () => {
      try {
        out = await w.b.cloudConnect.links.open(idOfA);
        return true;
      } catch {
        return false;
      }
    });
    await until(() => inbound.length === 1);
    const closed: unknown[] = [];
    out.onClose((c) => closed.push(c));
    w.worker.interAccount = false;
    await w.b.discover();
    await until(() => closed.length === 1);
    expect(closed[0]).toMatchObject({ code: "peer_bye", byPeer: false });
    await until(
      () =>
        [...w.net.adverts.values()].filter((a) => a.txt.includes("m=c"))
          .length === 1,
    );
    await expect(w.b.cloudConnect.links.open(idOfA)).rejects.toBeInstanceOf(
      UnsupportedError,
    );
    // The list is still readable; the contact is kept for when the gate comes back.
    expect(await w.b.cloudConnect.links.list()).toHaveLength(1);
  });

  it("a re-pair stores a pending contact that replaces the held one only after a handshake passes the pin", async () => {
    const w = await world();
    const { idOfB } = await link(w, ["notes"], ["notes"]);
    const before = await w.a.connect.contactRows();
    // Pair the same two devices again with another category set.
    const sa = await openPairing(w.a, w.net, ["notes", "docs"], "Ana2");
    const sb = await openPairing(w.b, w.net, ["notes", "docs"], "Bo2");
    await until(() => sa.offers.length === 1 && sb.offers.length === 1);
    await Promise.all([sa.offers[0]!.confirm(), sb.offers[0]!.confirm()]);
    await until(() => sa.linked.length === 1 && sb.linked.length === 1);
    expect(sa.linked[0]!.rePair).toBe(true);
    // The held contact is untouched; the new one waits.
    let rows = await w.a.connect.contactRows();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(before[0]);
    expect(rows[1]!.pendingSince).toBe(T0);
    expect((await w.a.cloudConnect.links.list())[0]).toMatchObject({
      label: "Bo",
      rePairPending: true,
    });
    // The first mode-c handshake under the new secret promotes it.
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    let out!: ConnectSession;
    await until(async () => {
      try {
        out = await w.a.cloudConnect.links.open(idOfB);
        return true;
      } catch {
        return false;
      }
    });
    expect(out.contact?.pending).toBe(true);
    await until(async () => (await w.a.connect.contactRows()).length === 1);
    rows = await w.a.connect.contactRows();
    expect(rows[0]).toMatchObject({ label: "Bo2", cats: ["docs", "notes"] });
    expect(rows[0]!.pendingSince).toBeUndefined();
    expect(rows[0]!.secret).not.toBe(before[0]!.secret);
  });

  it("drops a pending contact 24 hours after it was stored", async () => {
    const w = await world();
    await link(w, ["notes"], ["notes"]);
    const sa = await openPairing(w.a, w.net, ["notes"], "Ana");
    const sb = await openPairing(w.b, w.net, ["notes"], "Bo");
    await until(() => sa.offers.length === 1 && sb.offers.length === 1);
    await Promise.all([sa.offers[0]!.confirm(), sb.offers[0]!.confirm()]);
    await until(() => sa.linked.length === 1);
    expect(await w.a.connect.contactRows()).toHaveLength(2);
    vi.setSystemTime((T0 + 86_400) * 1000);
    expect(await w.a.connect.contactRows()).toHaveLength(1);
  });

  it("the shared listener still answers the person's own devices (mode a first, then the contacts)", async () => {
    const w = await world();
    await link(w);
    // A third device of A's account, on the same network.
    const c = await makeClient(w.worker, "3", dirs);
    clients.push(c);
    await c.discover();
    await c.connect.identity();
    await w.a.connect.identity({ refresh: true });
    await c.connect.identity({ refresh: true });
    await startLan(w.a, w.net);
    await startLan(c, w.net);
    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.onChannel((s) => inbound.push(s));
    let out!: ConnectSession;
    await until(async () => {
      try {
        out = await c.cloudConnect.open(devId("1"));
        return true;
      } catch {
        return false;
      }
    });
    await until(() => inbound.length === 1);
    expect(out.peerDeviceId).toBe(devId("1"));
    expect(out.contact).toBeNull();
    await out.send(utf8("account"));
    expect(text((await inbound[0]!.receive()).body)).toBe("account");
  });

  it("an unreadable contact row makes the record an error, never a silent reset", async () => {
    const w = await world();
    await link(w);
    const file = join(
      (w.a as unknown as { core: { dirs: { state: string } } }).core.dirs.state,
      CONNECT_STATE_FILE,
    );
    const rec = JSON.parse(readFileSync(file, "utf8"));
    rec.contacts[0].cats = ["Not Valid"];
    writeFileSync(file, JSON.stringify(rec), { mode: 0o600 });
    await expect(w.a.connect.contactRows()).rejects.toMatchObject({
      code: "store-failed",
    });
  });

  it("sign-out forgets the links with the rest of the record", async () => {
    const w = await world();
    await link(w);
    await w.a.connect.leave();
    expect(await w.a.cloudConnect.links.list()).toEqual([]);
  });
});

describe("mode c through the contact room", () => {
  const relay = (rooms: FakeContactRooms) => ({
    lan: false as const,
    relay: { webSocket: rooms.webSocket },
  });

  it("opens a session through the room with aliases on the wire, both ways", async () => {
    const w = await world();
    const { idOfB, idOfA } = await link(w);
    await w.a.cloudConnect.start(relay(w.rooms));
    await w.b.cloudConnect.start(relay(w.rooms));
    // A ticket is asked for with the room body, one room each, and the answer echoes it.
    await until(() => w.rooms.sockets.length === 2);
    expect(w.worker.ticketBodies.filter((b) => b !== "")).toHaveLength(2);
    for (const body of w.worker.ticketBodies.filter((b) => b !== ""))
      expect(JSON.parse(body)).toEqual({
        room: "c",
        rid: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      });

    const inbound: ConnectSession[] = [];
    w.a.cloudConnect.links.onLink((s) => inbound.push(s));
    const out = await w.b.cloudConnect.links.open(idOfA);
    await until(() => inbound.length === 1);
    expect(out.path).toBe("relay");
    expect(out.contact?.id).toBe(idOfA);
    expect(inbound[0]!.contact?.id).toBe(idOfB);
    await out.send(utf8("through the room"));
    expect(text((await inbound[0]!.receive()).body)).toBe("through the room");
    await inbound[0]!.send(utf8("answer"));
    expect(text((await out.receive()).body)).toBe("answer");

    // No device id crosses: every `to` the clients wrote is an alias of the room.
    const ids = [devId("1"), B].map((d) =>
      Buffer.from(d.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString(
        "hex",
      ),
    );
    for (const to of w.rooms.sentTo()) expect(ids).not.toContain(to);
    expect(w.rooms.sentTo().length).toBeGreaterThan(0);
  });

  it("holds a first message that arrives before MEMBERS and judges it on MEMBERS: a stranger is never seated as the peer", async () => {
    const w = await world();
    await link(w);
    await w.a.cloudConnect.start(relay(w.rooms));
    await until(() => w.rooms.sockets.length === 1);
    await until(() => w.rooms.received.some((r) => r.msg.op === "list"));
    const lists = () =>
      w.rooms.received.filter((r) => r.msg.op === "list").length;
    const before = lists();
    // The room has not named a peer yet (it holds this device only); a message from an alias that
    // MEMBERS never names arrives first.
    w.rooms.sockets[0]!.deliver({
      op: "recv",
      from: new Uint8Array(24).fill(7),
      session: 5,
      noise: new Uint8Array(48).fill(1),
    });
    // It is held and MEMBERS is asked for (a repeat of the same message does not grow the queue past 8).
    for (let i = 0; i < 12; i++)
      w.rooms.sockets[0]!.deliver({
        op: "recv",
        from: new Uint8Array(24).fill(7),
        session: 6 + i,
        noise: new Uint8Array(48).fill(1),
      });
    await until(() => lists() > before);
    // The answer does not name the stranger, so nothing is answered and no session opens.
    await new Promise((r) => setTimeout(r, 50));
    expect(w.rooms.received.some((r) => r.msg.op === "send")).toBe(false);
  });

  it("falls back from the LAN to the contact room when the contact was not seen on the network", async () => {
    const w = await world();
    const { idOfA } = await link(w);
    const roomsOnly = {
      lan: { mdns: w.net.adapter(), ...LOOP, browse: false, advertise: false },
      relay: { webSocket: w.rooms.webSocket },
    };
    await w.a.cloudConnect.start(roomsOnly);
    await w.b.cloudConnect.start(roomsOnly);
    await until(() => w.rooms.sockets.length === 2);
    const out = await w.b.cloudConnect.links.open(idOfA);
    expect(out.path).toBe("relay");
    // And never when the host turned the relay off for the call.
    await expect(
      w.b.cloudConnect.links.open(idOfA, { relay: false }),
    ).rejects.toBeInstanceOf(LanError);
  });

  it("an offline contact is not dialled", async () => {
    const w = await world();
    const { idOfA } = await link(w);
    await w.b.cloudConnect.start(relay(w.rooms));
    await expect(w.b.cloudConnect.links.open(idOfA)).rejects.toMatchObject({
      reason: "unknown_peer",
    });
  });

  it("a Worker that does not echo the room is treated as having no contact relay", async () => {
    const w = await world();
    await link(w);
    w.worker.echoRoom = false;
    await expect(
      w.b.connect.relayTicket({ room: "c", rid: "lXg0MgIHVN5qAmGFUen7vA" }),
    ).rejects.toMatchObject({
      constructor: RelayError,
      reason: "contact_unsupported",
    });
    await w.b.cloudConnect.start(relay(w.rooms));
    await new Promise((r) => setTimeout(r, 50));
    expect(w.rooms.sockets).toEqual([]);
  });

  it("maps 403 connect_links_disabled to its own reason", async () => {
    const w = await world();
    w.worker.interAccount = false;
    await expect(
      w.b.connect.relayTicket({ room: "c", rid: "lXg0MgIHVN5qAmGFUen7vA" }),
    ).rejects.toMatchObject({
      constructor: RelayError,
      reason: "links_disabled",
      code: "connect_links_disabled",
      status: 403,
    });
  });

  it("sends the account ticket without a body, and refuses a room echo on it", async () => {
    const w = await world();
    const g = await w.b.connect.relayTicket();
    expect(g.room).toBeUndefined();
    expect(w.worker.ticketBodies.at(-1)).toBe("");
  });

  it("a deleted contact's room is closed", async () => {
    const w = await world();
    const { idOfA } = await link(w);
    await w.b.cloudConnect.start(relay(w.rooms));
    await until(() => w.rooms.sockets.length === 1);
    await w.b.cloudConnect.links.remove(idOfA);
    await until(() => w.rooms.sockets.length === 0);
  });

  it("contactId is a stable 16-character name of the peer key, not the key", () => {
    const k = "A".repeat(43);
    expect(contactId(k)).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(contactId(k)).toBe(contactId(k));
    expect(contactId(k)).not.toContain(k.slice(0, 8));
  });
});

/** Hold every client write after the first on a socket (handshake message 3 and later) until `release()`. */
function holdThirdMessage() {
  const origConnect = Socket.prototype.connect;
  const origWrite = Socket.prototype.write;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { held: 0 };
  const marks = new WeakMap<object, number>();
  const proto = Socket.prototype as unknown as Record<string, unknown>;
  proto.connect = function (this: Socket, ...args: unknown[]) {
    marks.set(this, 0);
    return (origConnect as (...a: unknown[]) => unknown).apply(this, args);
  };
  proto.write = function (this: Socket, ...args: unknown[]) {
    const n = marks.get(this);
    if (n !== undefined) {
      marks.set(this, n + 1);
      if (n + 1 >= 2) {
        if (n + 1 === 2) state.held++;
        void gate.then(() =>
          (origWrite as (...a: unknown[]) => unknown).apply(this, args),
        );
        return true;
      }
    }
    return (origWrite as (...a: unknown[]) => unknown).apply(this, args);
  };
  return {
    state,
    release,
    restore: () => {
      proto.connect = origConnect;
      proto.write = origWrite;
    },
  };
}

describe("links: a handshake in flight when the footing goes (control: revoke-in-flight)", () => {
  async function inFlight(
    then: (
      w: Awaited<ReturnType<typeof world>>,
      idOfB: string,
    ) => Promise<void>,
  ) {
    const w = await world();
    const { idOfB, idOfA } = await link(w);
    await startLan(w.a, w.net);
    await startLan(w.b, w.net);
    const inbound: ConnectSession[] = [];
    const closes: { code: string }[] = [];
    w.a.cloudConnect.links.onLink((s) => {
      inbound.push(s);
      s.onClose((c) => closes.push(c));
    });
    const hold = holdThirdMessage();
    try {
      const dial = (async () => {
        for (let i = 0; i < 100 && hold.state.held === 0; i++) {
          try {
            return await w.b.cloudConnect.links.open(idOfA, {
              lanAttemptMs: 20000,
              relay: false,
            });
          } catch {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        return undefined;
      })();
      await until(() => hold.state.held === 1);
      await then(w, idOfB);
      hold.release();
      await dial.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      hold.restore();
    }
    return { inbound, closes };
  }

  it("remove() before the handshake completes: no session is delivered to the host", async () => {
    const { inbound } = await inFlight(async (w, idOfB) => {
      expect(await w.a.cloudConnect.links.remove(idOfB)).toBe(true);
    });
    expect(inbound).toHaveLength(0);
  });

  it("a gate flip before the handshake completes: no session is delivered to the host", async () => {
    const { inbound } = await inFlight(async (w) => {
      w.worker.interAccount = false;
      await w.a.discover();
    });
    expect(inbound).toHaveLength(0);
  });
});

describe("links: the cached gate", () => {
  it("a discovery that is not found closes the gate and withdraws the adverts", async () => {
    const w = await world();
    await link(w);
    await startLan(w.a, w.net);
    await until(() =>
      [...w.net.adverts.values()].some((a) => a.txt.includes("m=c")),
    );
    w.worker.discoveryStatus = 404;
    await w.a.discover();
    expect(w.a.cloudConnect.links.interAccount()).toBe(false);
    await until(
      () => ![...w.net.adverts.values()].some((a) => a.txt.includes("m=c")),
    );
  });

  it("an answer older than a day no longer counts", async () => {
    const w = await world();
    expect(w.a.cloudConnect.links.interAccount()).toBe(true);
    vi.setSystemTime((T0 + 25 * 3600) * 1000);
    expect(w.a.cloudConnect.links.interAccount()).toBe(false);
  });
});

describe("links: promotion follows the secret", () => {
  it("a session under a replaced pending secret does not promote the newer pending row", () => {
    const row = (secret: string, pendingSince?: number) => ({
      agreeKey: "A".repeat(43),
      secret,
      cats: ["notes"],
      createdAt: 1,
      reachable: true,
      ...(pendingSince !== undefined ? { pendingSince } : {}),
    });
    const s1 = base64UrlEncodeBytes(new Uint8Array(32).fill(1));
    const s2 = base64UrlEncodeBytes(new Uint8Array(32).fill(2));
    const rows = [row(s1), row(s2, 5)];
    const tag1 = secretTag(new Uint8Array(32).fill(1));
    const tag2 = secretTag(new Uint8Array(32).fill(2));
    expect(promoteRow(rows, "A".repeat(43), tag1)).toEqual(rows);
    expect(promoteRow(rows, "A".repeat(43), tag2).map((r) => r.secret)).toEqual(
      [s2],
    );
  });
});

describe("links: each in-flight layer on its own", () => {
  const fakeSession = (ref: ConnectSession["contact"]) => {
    const closes: string[] = [];
    const s = {
      contact: ref,
      close: async (code?: string) => {
        closes.push(code ?? "");
      },
      onClose: () => () => undefined,
    } as unknown as ConnectSession;
    return { s, closes };
  };

  async function attached(adopt?: (s: ConnectSession) => void) {
    const w = await world();
    const { idOfB } = await link(w);
    const ref = (await w.a.connect.contactRows())
      .filter((r) => r.pendingSince === undefined)
      .map((r) => ({
        id: idOfB,
        label: null,
        categories: ["notes"],
        agreeKey: r.agreeKey,
        pending: false,
        tag: secretTag(base64UrlDecode(r.secret)),
      }))[0]!;
    let push!: (s: ConnectSession) => void;
    const lan = {
      onContactSession: (fn: (s: ConnectSession) => void) => {
        push = fn;
        return () => undefined;
      },
    } as unknown as Parameters<CloudLinks["attach"]>[0];
    const links = new CloudLinks(w.a.connect, adopt ? { adopt } : {});
    links.attach(lan, null, { lanAttemptMs: 1000, relayOn: false });
    const delivered: ConnectSession[] = [];
    links.onLink((s) => delivered.push(s));
    return { w, idOfB, ref, push: (s: ConnectSession) => push(s), delivered };
  }

  it("links: a session that completes after its contact is gone is closed peer_revoked (control: revoke-in-flight, links layer)", async () => {
    const t = await attached();
    await t.w.a.cloudConnect.links.remove(t.idOfB);
    const { s, closes } = fakeSession(t.ref);
    t.push(s);
    await until(() => closes.length === 1);
    expect(closes).toEqual(["peer_revoked"]);
    expect(t.delivered).toHaveLength(0);
  });

  it("links: a session that completes after links go off is closed peer_bye (control: revoke-in-flight, links layer)", async () => {
    const t = await attached();
    t.w.worker.interAccount = false;
    await t.w.a.discover();
    const { s, closes } = fakeSession(t.ref);
    t.push(s);
    await until(() => closes.length === 1);
    expect(closes).toEqual(["peer_bye"]);
    expect(t.delivered).toHaveLength(0);
  });

  it("links: a session under a replaced pending secret promotes nothing and is closed", async () => {
    const t = await attached();
    const { s, closes } = fakeSession({ ...t.ref, tag: "AAAAAAAAAAAAAAAA" });
    t.push(s);
    await until(() => closes.length === 1);
    expect(closes).toEqual(["peer_revoked"]);
    expect(t.delivered).toHaveLength(0);
  });

  it("links: an inbound session that is no longer held is not handed to Direct Transfer", async () => {
    const adopted: ConnectSession[] = [];
    const t = await attached((s) => adopted.push(s));
    await t.w.a.cloudConnect.links.remove(t.idOfB);
    const gone = fakeSession(t.ref);
    t.push(gone.s);
    await until(() => gone.closes.length === 1);
    expect(adopted).toHaveLength(0);
    // A contact that is still held is handed over, once it has been checked.
    const w2 = await attached((s) => adopted.push(s));
    const ok = fakeSession(w2.ref);
    w2.push(ok.s);
    await until(() => w2.delivered.length === 1);
    expect(adopted).toEqual([ok.s]);
  });

  it("links: the LAN layer ends a handshake whose contact was removed before message 3, without the links layer", async () => {
    const w = await world();
    const { idOfB, idOfA } = await link(w);
    const lanA = await w.a.connect.lan({ mdns: w.net.adapter(), ...LOOP });
    const lanB = await w.b.connect.lan({ mdns: w.net.adapter(), ...LOOP });
    const seen: ConnectSession[] = [];
    lanA.onContactSession((s) => seen.push(s));
    const hold = holdThirdMessage();
    try {
      const dial = (async () => {
        for (let i = 0; i < 100 && hold.state.held === 0; i++) {
          try {
            return await lanB.connectContact(idOfA, false);
          } catch {
            await new Promise((r) => setTimeout(r, 10));
          }
        }
        return undefined;
      })();
      await until(() => hold.state.held === 1);
      expect(await w.a.cloudConnect.links.remove(idOfB)).toBe(true);
      hold.release();
      await dial.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      hold.restore();
      await lanA.stop().catch(() => undefined);
      await lanB.stop().catch(() => undefined);
    }
    expect(seen).toHaveLength(0);
  });

  it("links: a handshake under a pending contact promotes only the row whose secret opened it (contactEstablished)", async () => {
    const w = await world();
    const { idOfB } = await link(w, ["notes"], ["notes"]);
    const sa = await openPairing(w.a, w.net, ["notes", "docs"], "Ana2");
    const sb = await openPairing(w.b, w.net, ["notes", "docs"], "Bo2");
    await until(() => sa.offers.length === 1 && sb.offers.length === 1);
    await Promise.all([sa.offers[0]!.confirm(), sb.offers[0]!.confirm()]);
    await until(() => sa.linked.length === 1 && sb.linked.length === 1);
    const rows = await w.a.connect.contactRows();
    expect(rows).toHaveLength(2);
    const pend = rows.find((r) => r.pendingSince !== undefined)!;
    const ref = {
      id: idOfB,
      label: null,
      categories: ["notes"],
      agreeKey: pend.agreeKey,
      pending: true,
      tag: "AAAAAAAAAAAAAAAA",
    };
    await w.a.connect.lanSource().contactEstablished?.(ref);
    expect(await w.a.connect.contactRows()).toHaveLength(2);
    await w.a.connect.lanSource().contactEstablished?.({
      ...ref,
      tag: secretTag(base64UrlDecode(pend.secret)),
    });
    expect(await w.a.connect.contactRows()).toHaveLength(1);
  });
});

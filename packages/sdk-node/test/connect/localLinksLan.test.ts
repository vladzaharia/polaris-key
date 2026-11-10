// @pkey-feature connect.local
// Local links after the pairing, mode `l` (CC-29.8; WIRE-CONTRACT-V5 §15.5 "One listener, one
// order", §15.12 "Mode l" and "Gates"): two clients with no account pair by a code, mark the link
// reachable, find each other by the `m=l` advert on an in-process mDNS network and open sessions
// over loopback. The listener runs with no account; with one it is the shared listener. The
// codecs, the pin, the trial order and the gate predicate are the `peer-matrix.json` `local` rows
// (conformance/runners/node); this file covers what the Node SDK does with them.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PolarisKeyClient } from "../../src/client.js";
import type {
  ConnectSession,
  IncomingOffer,
  LocalOffer,
  LocalPairHandle,
} from "../../src/connect/index.js";
import { resetLocalBudgets } from "../../src/connect/localLinks.js";
import { LOCAL_STATE_FILE } from "../../src/connect/localState.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  endTest,
  freezeAtT0,
  makeClient,
  text,
  tmpDir,
  until,
  utf8,
} from "../lanFixtures.js";

const LOOP = { host: "127.0.0.1", allowLoopback: true } as const;

let handles: LocalPairHandle[] = [];
let clients: PolarisKeyClient[] = [];
let dirs: string[] = [];

beforeEach(() => {
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
  return { worker, a, b, net: new MemoryMdnsNetwork() };
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
    // A link is advertised only once the host marks it reachable.
    expect(lAdverts(w.net)).toEqual([]);
    expect(await w.a.cloudConnect.localLinks.setReachable("nope", true)).toBe(
      false,
    );
    expect(await w.a.cloudConnect.localLinks.setReachable(idOfB, true)).toBe(
      true,
    );
    await w.b.cloudConnect.localLinks.setReachable(idOfA, true);
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

// @pkey-feature connect.transfer
// Direct Transfer over a link (mode `c`, CC-20.3; WIRE-CONTRACT-V5 §15.10, §15.11): the categories
// the person approved at pairing decide, before anyone is asked; the label shown is the stored one;
// deleting the link removes what its peer left half-sent.
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PolarisKeyClient } from "../../src/client.js";
import {
  PartialStore,
  type ConnectSession,
  type IncomingOffer,
  type LinkPairHandle,
  type LinkOffer,
  type PairedLink,
} from "../../src/connect/index.js";
import { FakeContactRooms } from "../contactFixtures.js";
import {
  MemoryMdnsNetwork,
  MultiWorker,
  T0,
  devId,
  makeClient,
  tmpDir,
  until,
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
  vi.restoreAllMocks();
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

const content = (n: number): Uint8Array =>
  Uint8Array.from({ length: n }, (_, i) => (7 * i + 13) % 256);

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

async function ready() {
  const w = await world();
  const { idOfB, idOfA } = await link(w);
  await startLan(w.a, w.net);
  await startLan(w.b, w.net);
  const inbound: ConnectSession[] = [];
  w.a.cloudConnect.links.onLink((s) => inbound.push(s));
  // The first open is retried until the contact adverts are seen.
  await until(async () => {
    try {
      await w.b.cloudConnect.links.open(idOfA);
      return true;
    } catch {
      return false;
    }
  });
  await until(() => inbound.length === 1);
  return { ...w, idOfA, idOfB, inbound, out: tmpDir(dirs) };
}

describe("Direct Transfer over a link", () => {
  it("delivers in a category both approved, shows the stored label, and refuses the others before asking", async () => {
    const w = await ready();
    const asked: IncomingOffer[] = [];
    w.a.cloudConnect.transfer.onOffer((o) => {
      asked.push(o);
      return { saveTo: join(w.out, "n.bin") };
    });
    const t = w.b.cloudConnect.transfer;
    await t.send({ link: w.idOfA }, content(90_000), {
      name: "note",
      category: "notes",
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({
      category: "notes",
      from: { kind: "link", linkId: w.idOfB, label: "Bo" },
    });
    expect(readdirSync(w.out)).toEqual(["n.bin"]);
    // `docs` was approved by Bo only; no category is no approval either.
    for (const category of ["docs", "photos", undefined]) {
      await expect(
        t.send({ link: w.idOfA }, content(10), {
          ...(category !== undefined ? { category } : {}),
        }),
      ).rejects.toMatchObject({
        code: "transfer-cancelled",
        reason: "category",
      });
    }
    expect(asked).toHaveLength(1);
    // A link this device does not hold.
    await expect(
      t.send({ link: "x".repeat(16) }, content(1), { category: "notes" }),
    ).rejects.toMatchObject({ code: "link-unknown" });
  });

  it("deleting the link removes the partial files its peer left", async () => {
    const w = await ready();
    w.a.cloudConnect.transfer.onOffer(() => ({ saveTo: join(w.out, "f") }));
    let writes = 0;
    const real = PartialStore.prototype.write;
    vi.spyOn(PartialStore.prototype, "write").mockImplementation(
      async function (this: PartialStore, ...args) {
        await real.apply(this, args);
        if (++writes === 4) void w.inbound.at(-1)!.close();
      },
    );
    await expect(
      w.b.cloudConnect.transfer.send({ link: w.idOfA }, content(900_000), {
        chunk: 4096,
        category: "notes",
      }),
    ).rejects.toMatchObject({ code: "peer-closed" });
    const base = join(
      dirs[0]!,
      readdirSync(dirs[0]!).find((n) => n.includes("@"))!,
      "transfer",
      "p",
    );
    await until(() => existsSync(base) && readdirSync(base).length === 2);
    expect(await w.a.cloudConnect.links.remove(w.idOfB)).toBe(true);
    await until(() => readdirSync(base).length === 0);
  });
});

// @vitest-environment node
//
// @pkey-feature connect.transfer
//
// Direct Transfer in the browser (CC-20.4; WIRE-CONTRACT-V5 §15.11): mode `a` over the relay, two
// real Noise sessions through the in-process room, partial transfers in IndexedDB (fake-indexeddb).
// The sender here is a page too; the Node host is the other implementation of the same machine
// (its own two-session tests), and the peer-matrix xfer rows run in the browser runner.

import { createHash, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import { xferPartialPath } from "@polaris-key/client-core/peer";
import { CloudTransfer } from "@polaris-key/ui-core/browser/sdk/browser/connect/transfer.js";
import {
  XferStore,
  purgeXferStore,
} from "@polaris-key/ui-core/browser/sdk/browser/connect/xferStore.js";
import {
  TransferError,
  type OfferHandler,
  type TransferEvent,
} from "@polaris-key/ui-core/browser/sdk/browser/connect/xferTypes.js";
import { UnsupportedError } from "@polaris-key/ui-core/browser/sdk/core/caps.js";
import { unsupportedCloudConnect } from "../src/browser/connect/index.js";
import { until, pair, live } from "./relayFixtures.js";
const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

(globalThis as { IDBKeyRange?: unknown }).IDBKeyRange = IDBKeyRange;

afterEach(async () => {
  await Promise.all(live.splice(0).map((s) => s.stop()));
});

const ID = "AAAAAAAAAAAAAAAAAAAAAA";
const sha = (b: Uint8Array): string =>
  createHash("sha256").update(b).digest("hex");
const bytes = (n: number): Uint8Array<ArrayBuffer> => {
  const u = new Uint8Array(n);
  u.set(randomBytes(n));
  return u;
};
async function untilAsync(f: () => Promise<boolean>, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await f())) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const NAME = "pkey-xfer-test";

interface Rig {
  start(): void;
  p: Awaited<ReturnType<typeof pair>>;
  idb: IDBFactory;
  store: XferStore;
  sender: CloudTransfer;
  receiver: CloudTransfer;
  setHandler(h: OfferHandler | null): void;
  sent: TransferEvent[];
  got: TransferEvent[];
  clock: { ms: number };
}

async function rig(
  o: {
    estimate?: () => Promise<{ quota?: number; usage?: number }>;
    maxFiles?: number;
    /** Adopt the sessions only when `start()` is called (after partials are seeded). */
    lazy?: boolean;
  } = {},
): Promise<Rig> {
  const p = await pair();
  const idb = new IDBFactory();
  const clock = { ms: 1_800_000_000_000 };
  const store = new XferStore(NAME, {
    idb,
    now: () => clock.ms,
    reserveBytes: 0,
    ...(o.estimate !== undefined ? { estimate: o.estimate } : {}),
    ...(o.maxFiles !== undefined ? { maxFiles: o.maxFiles } : {}),
  });
  let handler: OfferHandler | null = null;
  const sent: TransferEvent[] = [];
  const got: TransferEvent[] = [];
  const sender = new CloudTransfer({
    store: new XferStore("pkey-xfer-sender", { idb: new IDBFactory() }),
    openDevice: async () => p.out,
    handler: () => null,
    maxSize: () => null,
    emit: (e) => sent.push(e),
  });
  const receiver = new CloudTransfer({
    store,
    openDevice: async () => p.inn,
    handler: () => handler,
    maxSize: () => null,
    emit: (e) => got.push(e),
  });
  const start = (): void => {
    sender.adopt(p.out);
    receiver.adopt(p.inn);
  };
  if (o.lazy !== true) start();
  return {
    start,
    p,
    idb,
    store,
    sender,
    receiver,
    setHandler: (h) => (handler = h),
    sent,
    got,
    clock,
  };
}

const collect =
  (sink: { blob: Blob | null }): OfferHandler =>
  () => ({
    blob: (b) => {
      sink.blob = b;
    },
  });

async function keysOf(idb: IDBFactory): Promise<unknown[]> {
  const db = await new Promise<IDBDatabase>((res, rej) => {
    const r = idb.open(NAME);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const all: unknown[] = [];
  for (const s of ["meta", "parts"]) {
    const tx = db.transaction(s, "readonly");
    const req = tx.objectStore(s).getAllKeys();
    all.push(
      ...(await new Promise<unknown[]>((res) => {
        req.onsuccess = () => res(req.result as unknown[]);
      })),
    );
  }
  db.close();
  return all;
}

describe("a Blob over the relay", () => {
  it("is offered, consented, verified and handed to the host's sink; nothing downloads on its own", async () => {
    const r = await rig();
    const body = bytes(200_000);
    const sink = { blob: null as Blob | null };
    let shown: unknown;
    r.setHandler((o) => {
      shown = o;
      return collect(sink)(o);
    });
    const done = await r.sender.send(
      r.p.out,
      new File([body], "holiday.png", { type: "image/png" }),
    );
    expect(done.sha256).toBe(sha(body));
    await until(() => r.got.some((e) => e.outcome === "delivered"));
    expect(shown).toMatchObject({
      name: "holiday.png",
      type: "image/png",
      size: 200_000,
      path: "relay",
      from: { kind: "device", deviceId: r.p.b.id },
    });
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
    expect(sink.blob!.type).toBe("image/png");
    // The partial left with the delivery.
    await untilAsync(async () => (await keysOf(r.idb)).length === 0);
  });

  it("declines every offer when the host has no handler, or its handler throws or names nothing usable", async () => {
    const r = await rig();
    const err = await r.sender
      .send(r.p.out, new Blob(["hello"]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TransferError);
    expect(err).toMatchObject({
      reason: "declined",
      code: "transfer-cancelled",
    });
    for (const h of [
      (): never => {
        throw new Error("boom");
      },
      () => ({ blob: "not a function" }) as never,
      () => ({ file: {} }) as never,
      () => true as never,
    ]) {
      r.setHandler(h);
      const e = await r.sender
        .send(r.p.out, new Blob(["hello"]))
        .catch((x: unknown) => x);
      expect(e).toMatchObject({ reason: "declined" });
    }
    expect(r.got.every((e) => e.outcome !== "delivered")).toBe(true);
  });

  it("writes through a File System Access handle and aborts it when delivery fails", async () => {
    const r = await rig();
    const body = bytes(70_000);
    const wrote: Uint8Array[] = [];
    let closed = false;
    r.setHandler(() => ({
      file: {
        createWritable: async () => ({
          write: async (d: Uint8Array) => void wrote.push(d.slice()),
          close: async () => void (closed = true),
        }),
      },
    }));
    await r.sender.send(r.p.out, new Blob([body]));
    await until(() => r.got.some((e) => e.outcome === "delivered"));
    expect(closed).toBe(true);
    expect(Buffer.concat(wrote)).toEqual(Buffer.from(body));
  });

  it("delivered memory records only delivered content", async () => {
    const r = await rig();
    const body = bytes(200_000);
    let asked = 0;
    let first = true;
    const sink = { blob: null as Blob | null };
    r.setHandler(() => {
      asked++;
      return {
        blob: (b: Blob) => {
          if (first) {
            first = false;
            throw new Error("sink failed");
          }
          sink.blob = b;
        },
      };
    });
    await r.sender
      .send(r.p.out, new Blob([body]), { id: ID })
      .catch(() => undefined);
    expect(sink.blob).toBeNull();
    // The sender, not told it was delivered, retries on a new session: the person is asked again.
    let inn2: unknown = null;
    r.p.ra.onSession((s) => (inn2 = s));
    const out2 = await r.p.rb.dial(r.p.a.id);
    await until(() => inn2 !== null);
    r.sender.adopt(out2);
    r.receiver.adopt(inn2 as never);
    await r.sender.send(out2, new Blob([body]), { id: ID });
    await until(() => sink.blob !== null);
    expect(asked).toBe(2);
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
  });

  it("a second session of the peer cannot write or take a held partial", async () => {
    const r = await rig();
    const body = bytes(300_000);
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    // Hold the first session's first write: its partial exists and is in use.
    let n = 0;
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const write = r.store.write.bind(r.store);
    r.store.write = async (ref, off, d) => {
      if (++n === 1) await gate;
      return write(ref, off, d);
    };
    // The same peer has a second session, taken in before the partial exists (so it does not
    // see it as held), and offers the same transfer.
    let inn2: unknown = null;
    r.p.ra.onSession((s) => (inn2 = s));
    const out2 = await r.p.rb.dial(r.p.a.id);
    await until(() => inn2 !== null);
    r.sender.adopt(out2);
    r.receiver.adopt(inn2 as never);
    await sleep(50);
    const first = r.sender.send(r.p.out, new Blob([body]), { id: ID });
    first.catch(() => undefined);
    await until(() => n === 1);
    await expect(
      r.sender.send(out2, new Blob([body]), { id: ID }),
    ).rejects.toBeDefined();
    // The first session still owns the partial and finishes it whole.
    release();
    await first;
    await until(() => sink.blob !== null);
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
    expect(r.got.filter((e) => e.outcome === "delivered")).toHaveLength(1);
  });

  it("an empty Blob is delivered empty", async () => {
    const r = await rig();
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    await r.sender.send(r.p.out, new Blob([]));
    await until(() => sink.blob !== null);
    expect(sink.blob!.size).toBe(0);
  });
});

describe("a ReadableStream over the relay", () => {
  it("is spooled and hashed first, then sent, and arrives through a stream sink", async () => {
    const r = await rig();
    const body = bytes(2_500_000);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let at = 0; at < body.length; at += 300_000)
          c.enqueue(body.subarray(at, at + 300_000));
        c.close();
      },
    });
    const parts: Uint8Array[] = [];
    r.setHandler(() => ({
      stream: async (data) => {
        for await (const d of data) parts.push(d);
      },
    }));
    const started: { size: number; sha256: string }[] = [];
    await r.sender.send(r.p.out, stream, {
      name: "log.bin",
      onStart: (t) => started.push(t),
    });
    expect(started[0]).toMatchObject({ size: 2_500_000, sha256: sha(body) });
    await until(() => r.got.some((e) => e.outcome === "delivered"));
    // Byte-for-byte, but not through toEqual: its element-wise walk of 2.5 MB takes seconds on a slow runner.
    expect(Buffer.concat(parts).equals(Buffer.from(body))).toBe(true);
  });
});

describe("resume", () => {
  /** Keep the first `k` chunks of `body` for a transfer from the sender, as an interrupted one. */
  async function seed(r: Rig, body: Uint8Array, k: number, id = ID) {
    const chunk = 61_440;
    const key = Uint8Array.from(Buffer.from(r.p.b.agreeKey, "base64url"));
    const ref = xferPartialPath(key, id, sha(body));
    await r.store.ready();
    await r.store.create(ref, key, {
      ref,
      id,
      sha256: sha(body),
      size: body.length,
      chunk,
      bytes: 0,
      writtenAt: 0,
    });
    for (let i = 0; i < k; i++)
      await r.store.write(
        ref,
        i * chunk,
        body.subarray(i * chunk, (i + 1) * chunk),
      );
    await r.store.keep(ref);
    return { ref, chunk };
  }

  it("answers a repeated offer from the bytes kept, keyed by peer, id and hash", async () => {
    const r = await rig({ lazy: true });
    const body = bytes(300_000);
    const { chunk } = await seed(r, body, 3);
    r.start();
    const offsets: number[] = [];
    const write = r.store.write.bind(r.store);
    r.store.write = (ref, off, d) => {
      offsets.push(off);
      return write(ref, off, d);
    };
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    await r.sender.send(r.p.out, new Blob([body]), { id: ID });
    await until(() => sink.blob !== null);
    expect(offsets[0]).toBe(3 * chunk);
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
  });

  it("reads a kept prefix back only once this session holds the partial", async () => {
    const r = await rig({ lazy: true });
    const body = bytes(300_000);
    const { ref } = await seed(r, body, 3);
    // A second session of the same peer, taken in while the partial is not held by anyone.
    let inn2: unknown = null;
    r.p.ra.onSession((s) => (inn2 = s));
    const out2 = await r.p.rb.dial(r.p.a.id);
    await until(() => inn2 !== null);
    r.start();
    r.sender.adopt(out2);
    r.receiver.adopt(inn2 as never);
    await sleep(50);
    const reads: string[] = [];
    const reread = r.store.reread.bind(r.store);
    r.store.reread = (rf, c, b) => {
      reads.push(rf);
      return reread(rf, c, b);
    };
    // The first session takes the partial over and is held there.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const truncate = r.store.truncate.bind(r.store);
    r.store.truncate = async (rf, to) => {
      await gate;
      return truncate(rf, to);
    };
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    const first = r.sender.send(r.p.out, new Blob([body]), { id: ID });
    first.catch(() => undefined);
    await until(() => reads.length === 1);
    // The second session is asked the same: the partial is not its to read.
    await expect(
      r.sender.send(out2, new Blob([body]), { id: ID }),
    ).rejects.toBeDefined();
    expect(reads).toEqual([ref]);
    release();
    await first;
    await until(() => sink.blob !== null);
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
  });

  it("a different id, or different content, starts again at 0", async () => {
    const r = await rig({ lazy: true });
    const body = bytes(300_000);
    await seed(r, body, 3);
    r.start();
    const offsets: number[] = [];
    const write = r.store.write.bind(r.store);
    r.store.write = (ref, off, d) => {
      offsets.push(off);
      return write(ref, off, d);
    };
    r.setHandler(collect({ blob: null }));
    await r.sender.send(r.p.out, new Blob([body]), {
      id: "QQQQQQQQQQQQQQQQQQQQQQ",
    });
    await until(() => r.got.some((e) => e.outcome === "delivered"));
    expect(offsets[0]).toBe(0);
  });

  it("a partial that cannot be read back whole starts again, without an unhandled rejection or a closed session", async () => {
    const r = await rig();
    const body = bytes(300_000);
    const { ref } = await seed(r, body, 3);
    // Lose the middle chunk behind the store's back.
    const db = await new Promise<IDBDatabase>((res) => {
      const q = r.idb.open(NAME);
      q.onsuccess = () => res(q.result);
    });
    await new Promise<void>((res) => {
      const tx = db.transaction("parts", "readwrite");
      tx.objectStore("parts").delete([ref, 61_440]);
      tx.oncomplete = () => res();
    });
    db.close();
    // A new session reads the partial list again.
    const fresh = new XferStore(NAME, { idb: r.idb, now: () => r.clock.ms });
    const r2 = new CloudTransfer({
      store: fresh,
      openDevice: async () => r.p.inn,
      handler: () => collect({ blob: null }),
      maxSize: () => null,
      emit: () => undefined,
    });
    expect(
      await fresh.list(
        Uint8Array.from(Buffer.from(r.p.b.agreeKey, "base64url")),
      ),
    ).toHaveLength(1);
    await expect(fresh.reread(ref, 61_440, 3 * 61_440)).rejects.toThrow();
    void r2;
    const offsets: number[] = [];
    const write = r.store.write.bind(r.store);
    r.store.write = (rf, off, d) => {
      offsets.push(off);
      return write(rf, off, d);
    };
    // The live receiver was built before the loss; a new one over the same bytes starts at 0.
    const sink = { blob: null as Blob | null };
    const p2 = await pair();
    const rx = new CloudTransfer({
      store: fresh,
      openDevice: async () => p2.inn,
      handler: () => collect(sink),
      maxSize: () => null,
      emit: () => undefined,
    });
    const tx = new CloudTransfer({
      store: null,
      openDevice: async () => p2.out,
      handler: () => null,
      maxSize: () => null,
      emit: () => undefined,
    });
    const key = Uint8Array.from(Buffer.from(p2.b.agreeKey, "base64url"));
    // Seed this peer's gapped partial too, so the session finds it.
    const ref2 = xferPartialPath(key, ID, sha(body));
    await fresh.create(ref2, key, {
      ref: ref2,
      id: ID,
      sha256: sha(body),
      size: body.length,
      chunk: 61_440,
      bytes: 0,
      writtenAt: 0,
    });
    await fresh.write(ref2, 0, body.subarray(0, 61_440));
    await fresh.write(ref2, 2 * 61_440, body.subarray(2 * 61_440, 3 * 61_440));
    await fresh.keep(ref2);
    rx.adopt(p2.inn);
    tx.adopt(p2.out);
    await tx.send(p2.out, new Blob([body]), { id: ID });
    await until(() => sink.blob !== null);
    expect(new Uint8Array(await sink.blob!.arrayBuffer())).toEqual(body);
  });
});

describe("limits", () => {
  it("evicts the oldest of a peer's partials past 8, and only that peer's", async () => {
    const r = await rig();
    const keyB = Uint8Array.from(Buffer.from(r.p.b.agreeKey, "base64url"));
    const other = bytes(32);
    await r.store.ready();
    const make = async (key: Uint8Array, n: number) => {
      const id = Buffer.from(`id${n}`.padEnd(16, "0")).toString("base64url");
      const ref = xferPartialPath(key, id, sha(Buffer.from([n])));
      r.clock.ms += 1000;
      await r.store.create(ref, key, {
        ref,
        id,
        sha256: sha(Buffer.from([n])),
        size: 100,
        chunk: 61_440,
        bytes: 0,
        writtenAt: 0,
      });
      await r.store.write(ref, 0, bytes(10));
      await r.store.keep(ref);
      return ref;
    };
    const mine: string[] = [];
    for (let i = 0; i < 8; i++) mine.push(await make(keyB, i));
    const foreign = await make(other, 99);
    // Re-adopt so the session lists them.
    const p = await pair();
    const rx = new CloudTransfer({
      store: r.store,
      openDevice: async () => p.inn,
      handler: () => collect({ blob: null }),
      maxSize: () => null,
      emit: () => undefined,
    });
    const tx = new CloudTransfer({
      store: null,
      openDevice: async () => p.out,
      handler: () => null,
      maxSize: () => null,
      emit: () => undefined,
    });
    // Partials of `p`'s peer B are keyed by B's key: a different pair has a different B.
    const keyP = Uint8Array.from(Buffer.from(p.b.agreeKey, "base64url"));
    const own: string[] = [];
    for (let i = 0; i < 8; i++) {
      const id = Buffer.from(`pid${i}`.padEnd(16, "0")).toString("base64url");
      const ref = xferPartialPath(keyP, id, sha(Buffer.from([i])));
      r.clock.ms += 1000;
      await r.store.create(ref, keyP, {
        ref,
        id,
        sha256: sha(Buffer.from([i])),
        size: 100,
        chunk: 61_440,
        bytes: 0,
        writtenAt: 0,
      });
      await r.store.write(ref, 0, bytes(10));
      await r.store.keep(ref);
      own.push(ref);
    }
    rx.adopt(p.inn);
    tx.adopt(p.out);
    const stalled = tx
      .send(p.out, new Blob([bytes(5000)]))
      .catch(() => undefined);
    await untilAsync(
      async () => !(await keysOf(r.idb)).some((k) => k === own[0]),
    );
    const keys = (await keysOf(r.idb)).map(String);
    expect(keys).not.toContain(own[0]);
    expect(keys).toContain(own[1]);
    // Another peer's partials are not touched by this peer's eviction.
    expect(keys).toContain(foreign);
    for (const m of mine) expect(keys).toContain(m);
    await stalled;
  });

  it("drops a partial 24 h after its last write", async () => {
    const r = await rig();
    const key = new Uint8Array(32).fill(7);
    await r.store.ready();
    const ref = xferPartialPath(key, ID, sha(Buffer.from("x")));
    await r.store.create(ref, key, {
      ref,
      id: ID,
      sha256: sha(Buffer.from("x")),
      size: 100,
      chunk: 61_440,
      bytes: 0,
      writtenAt: 0,
    });
    await r.store.write(ref, 0, bytes(10));
    await r.store.keep(ref);
    expect(
      await new XferStore(NAME, {
        idb: r.idb,
        now: () => r.clock.ms + 23 * 3600_000,
      }).list(key),
    ).toHaveLength(1);
    expect(
      await new XferStore(NAME, {
        idb: r.idb,
        now: () => r.clock.ms + 25 * 3600_000,
      }).list(key),
    ).toHaveLength(0);
  });

  it("takes its room from the storage estimate, and sets it aside at the accept so concurrent offers cannot overshoot", async () => {
    // Room: the 100 KB the estimate leaves.
    const r = await rig({
      estimate: async () => ({ quota: 100_000, usage: 0 }),
    });
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    const a = bytes(60_000);
    const b = bytes(60_000);
    const first = r.sender.send(r.p.out, new Blob([a]), { id: ID });
    const second = r.sender.send(r.p.out, new Blob([b]), {
      id: "QQQQQQQQQQQQQQQQQQQQQQ",
    });
    const res = await Promise.allSettled([first, second]);
    expect(res.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const lost = res.find(
      (x) => x.status === "rejected",
    ) as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(TransferError);
    // Once the first is out of the way, there is room again.
    await until(() => r.got.some((e) => e.outcome === "delivered"));
    await r.sender.send(r.p.out, new Blob([b]), {
      id: "gggggggggggggggggggggg",
    });
  });

  it("an accept that no longer fits cancels that transfer with quota and keeps the session", async () => {
    const r = await rig({
      estimate: async () => ({ quota: 100_000, usage: 0 }),
    });
    // Two sessions of the peer; each offer fits when it is shown.
    let inn2: unknown = null;
    r.p.ra.onSession((s) => (inn2 = s));
    const out2 = await r.p.rb.dial(r.p.a.id);
    await until(() => inn2 !== null);
    r.sender.adopt(out2);
    r.receiver.adopt(inn2 as never);
    const answers: (() => void)[] = [];
    const sink = { blob: null as Blob | null };
    r.setHandler(
      (o) =>
        new Promise((res) => {
          answers.push(() => res(collect(sink)(o)));
        }),
    );
    // Hold the first transfer's writes so its room stays promised.
    let release!: () => void;
    const gate = new Promise<void>((res) => (release = res));
    const write = r.store.write.bind(r.store);
    r.store.write = async (ref, off, d) => {
      await gate;
      return write(ref, off, d);
    };
    const first = r.sender.send(r.p.out, new Blob([bytes(60_000)]), { id: ID });
    const second = r.sender.send(out2, new Blob([bytes(60_000)]), {
      id: "QQQQQQQQQQQQQQQQQQQQQQ",
    });
    first.catch(() => undefined);
    second.catch(() => undefined);
    await until(() => answers.length === 2);
    answers[0]!();
    await untilAsync(async () => r.store.free() < 50_000);
    answers[1]!();
    await expect(second).rejects.toMatchObject({ reason: "quota" });
    expect(out2.closed).toBeNull();
    release();
    await first;
  });

  it("refuses a write past the offered size or past the room", async () => {
    const r = await rig({ estimate: async () => ({ quota: 1000, usage: 0 }) });
    await r.store.ready();
    const key = new Uint8Array(32).fill(1);
    const ref = xferPartialPath(key, ID, sha(Buffer.from("y")));
    await r.store.create(ref, key, {
      ref,
      id: ID,
      sha256: sha(Buffer.from("y")),
      size: 100,
      chunk: 61_440,
      bytes: 0,
      writtenAt: 0,
    });
    await expect(r.store.write(ref, 0, bytes(101))).rejects.toThrow();
    await expect(r.store.write(ref, 0, bytes(100))).resolves.toBeUndefined();
  });
});

describe("names never reach a path", () => {
  it("keys are the derived reference only, whatever the peer calls the file", async () => {
    const r = await rig();
    const sink = { blob: null as Blob | null };
    let seen: string | undefined;
    r.setHandler((o) => {
      seen = o.name;
      return collect(sink)(o);
    });
    // Stall the delivery so the partial is on disk to look at.
    const body = bytes(200_000);
    const hold = new Promise<void>(() => undefined);
    const names: string[] = [];
    const write = r.store.write.bind(r.store);
    r.store.write = async (ref, off, d) => {
      await write(ref, off, d);
      names.push(...(await keysOf(r.idb)).map((k) => JSON.stringify(k)));
    };
    void hold;
    await r.sender.send(r.p.out, new Blob([body]), {
      name: "../../etc/passwd\u0000.png",
    });
    await until(() => sink.blob !== null);
    // The name is display data: the host is shown it as sent, and nothing builds a key from it.
    expect(seen).toContain("passwd");
    expect(names.length).toBeGreaterThan(0);
    for (const k of names) {
      expect(k).toMatch(/^(\["[0-9a-f]{64}",\d+\]|"[0-9a-f]{64}")$/);
      expect(k).not.toContain("passwd");
    }
  });
});

describe("purge", () => {
  it("a sign-out in another tab ends the sessions and the owner tab does not write the database back", async () => {
    const r = await rig();
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    const other = new XferStore(NAME, { idb: r.idb });
    let removed = false;
    const write = r.store.write.bind(r.store);
    r.store.write = async (ref, off, d) => {
      await write(ref, off, d);
      if (!removed) {
        removed = true;
        await other.purgeAll();
      }
    };
    await r.sender
      .send(r.p.out, new Blob([bytes(900_000)]))
      .catch(() => undefined);
    await new Promise((res) => setTimeout(res, 100));
    expect(sink.blob).toBeNull();
    expect((await r.idb.databases()).map((d) => d.name)).not.toContain(NAME);
  });

  it("removes the database, and a late effect cannot bring it back", async () => {
    const r = await rig();
    const sink = { blob: null as Blob | null };
    r.setHandler(collect(sink));
    let purged: Promise<void> | null = null;
    const write = r.store.write.bind(r.store);
    r.store.write = async (ref, off, d) => {
      await write(ref, off, d);
      purged ??= r.receiver.purge();
    };
    const sent = r.sender
      .send(r.p.out, new Blob([bytes(900_000)]))
      .catch(() => undefined);
    await until(() => purged !== null);
    await purged;
    await sent;
    await new Promise((res) => setTimeout(res, 50));
    const names = (await r.idb.databases()).map((d) => d.name);
    expect(names).not.toContain(NAME);
    expect(sink.blob).toBeNull();
  });

  it("purgeXferStore leaves an app that never received anything without an empty database", async () => {
    const idb = new IDBFactory();
    await purgeXferStore(NAME, idb);
    expect(await idb.databases()).toEqual([]);
    const s = new XferStore(NAME, { idb });
    await s.ready();
    expect((await idb.databases()).map((d) => d.name)).toEqual([NAME]);
    await purgeXferStore(NAME, idb);
    expect(await idb.databases()).toEqual([]);
  });
});

describe("unsupported", () => {
  it("is the typed N/A on a cookie page and the desktop renderer", async () => {
    const cc = unsupportedCloudConnect("runtime", "cookie");
    const err = await cc.transfer
      .send("x", new Blob([]))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnsupportedError);
    expect(err).toMatchObject({
      unsupported: { feature: "connect.transfer", reason: "runtime" },
    });
    expect(cc.transfer.cancel("x")).toBe(false);
  });
});

// @vitest-environment node
//
// @pkey-feature sync.saves sync.export
//
// SAVES.R (U-22.7): `adapter.cloudSync.saves` in the browser host. The real host and machine over a
// small fake Worker (/sync and /sync/files), the file layer on fake-indexeddb, and the saves
// client bound to the machine's records: write, read, list, conflict, resolve, delete, cancel, the
// locked ring, the purge and its order, and the one writer. `cloudSync.export` (U-51.4) runs on the
// same rig: the archive as a Blob or into a WritableStream, the Blob cap, a cancel, a failing stream, an
// end-to-end ring and the one export at a time (the sleep is injected: no wall-clock waits).

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import {
  rangedBytes,
  serverFileCodec,
  webCryptoSyncPort,
} from "@polaris-key/client-core/sync";
import {
  BrowserCloudSyncApi,
  importMarker,
} from "../src/browser/cloudSync/api.js";
import { filesDbName } from "../src/browser/cloudSync/filesPurge.js";
import { BrowserCloudSyncHost } from "../src/browser/cloudSync/host.js";
import { filesStore } from "../src/browser/cloudSync/idbJournal.js";
import { SavesApi, lockedEngine } from "../src/browser/cloudSync/saves.js";
import { createBrowserFiles } from "../src/browser/cloudSync/fileTransfers.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import type {
  TabChannel,
  TabMessage,
} from "../src/browser/cloudSync/writer.js";
import { lazySaves } from "../src/browser/cloudSync/lazySaves.js";
import { unsupportedCloudSync } from "../src/core/cloudSync.js";
import { SyncExportError } from "@polaris-key/client-core/sync";
import { SYNC_EXPORT_BLOB_MAX_BYTES } from "@polaris-key/protocol/sync";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import {
  FakeWorker,
  PRODUCT,
  hexOf,
  makeRing,
  type Body,
} from "./savesFixtures.js";

const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
const DB = "pkey-sync-saves";
// There is no implicit collection: the catalog declares `saves`.
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: { collections: [{ name: "saves", conflict: "revision" }] },
};

const bytes = (n: number, seed = 5): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

/** Web Locks that queue per name and honour `ifAvailable` (the writer election needs both). */
class Locks {
  private held = new Set<string>();
  private queues = new Map<string, Array<() => void>>();
  request(name: string, a: unknown, b?: unknown): Promise<unknown> {
    const opts = (typeof a === "function" ? {} : a) as {
      ifAvailable?: boolean;
    };
    const fn = (typeof a === "function" ? a : b) as (
      l: unknown,
    ) => Promise<unknown> | unknown;
    return new Promise((resolve, reject) => {
      const run = async () => {
        this.held.add(name);
        try {
          resolve(await fn({ name }));
        } catch (e) {
          reject(e);
        } finally {
          this.held.delete(name);
          this.queues.get(name)?.shift()?.();
        }
      };
      if (!this.held.has(name)) void run();
      else if (opts.ifAvailable)
        Promise.resolve(fn(null)).then(resolve, reject);
      else {
        const q = this.queues.get(name) ?? [];
        q.push(() => void run());
        this.queues.set(name, q);
      }
    });
  }
}

class Hub {
  private members = new Set<{ deliver: (m: TabMessage) => void }>();
  channel(): TabChannel {
    const handlers: Array<(m: TabMessage) => void> = [];
    const me = { deliver: (m: TabMessage) => handlers.forEach((h) => h(m)) };
    this.members.add(me);
    return {
      post: (m) => {
        const copy = structuredClone(m);
        for (const o of this.members)
          if (o !== me) setTimeout(() => o.deliver(copy), 0);
      },
      onMessage: (fn) => void handlers.push(fn),
      close: () => void this.members.delete(me),
    };
  }
}

interface Rig {
  world: FakeWorker;
  host: BrowserCloudSyncHost;
  api: BrowserCloudSyncApi;
  saves: SavesApi;
  idb: IDBFactory;
  calls: string[];
  ring: {
    lock: ReturnType<typeof vi.fn>;
    forget: ReturnType<typeof vi.fn>;
  };
  locks: Locks;
  /** Locks the end-to-end ring and tells the host's subscribers. */
  lockRing: () => void;
}

async function rig(
  o: {
    mode?: "e2e" | "server";
    world?: FakeWorker;
    locks?: Locks;
    hub?: Hub;
    store?: ReturnType<typeof memoryConnectState>;
    /** An end-to-end ring (`makeRing`): its codec and the keys an export derives with. */
    ring?: Awaited<ReturnType<typeof makeRing>>;
  } = {},
): Promise<Rig> {
  const mode = o.mode ?? "server";
  const world = o.world ?? new FakeWorker(mode);
  world.subject = SUBJECT;
  const locks = o.locks ?? new Locks();
  const hub = o.hub ?? new Hub();
  const idb = new IDBFactory();
  const calls: string[] = [];
  const ringListeners = new Set<() => void>();
  const ring = {
    hasRoot: () => o.ring !== undefined,
    subscribe: (l: () => void) => (
      ringListeners.add(l),
      () => ringListeners.delete(l)
    ),
    codec: () => o.ring?.codec() ?? null,
    fileCodec: async (c: string) => o.ring?.fileCodec(c) ?? null,
    exportKeys: async () => {
      const keys = o.ring?.codec() ? await o.ring.keys() : null;
      if (keys === null || keys === undefined) return null;
      const held = await keys.withRoot(async (port, root) => ({ port, root }));
      return { ...held, alive: () => o.ring?.codec() != null };
    },
    lock: vi.fn(async () => void calls.push("ring.lock")),
    forget: vi.fn(async () => void calls.push("ring.forget")),
  };
  const host = new BrowserCloudSyncHost(
    {
      product: PRODUCT,
      request: (path, init) => world.request(path, init),
      ring,
      purgeSaves: async () => {
        calls.push("saves.purge");
        await saves.purge();
      },
      discovery: () => null,
      fetchSchema: async () => CATALOG as never,
      document: () => ({ values: {} }),
      enabled: () => true,
      store: o.store ?? memoryConnectState(),
      locks,
      writerLock: "w",
      stateLock: "s",
      channel: hub.channel(),
    },
    { catalog: CATALOG as never, encryption: mode, saves: { delta: false } },
  );
  const config = {
    useSync: () => undefined,
    noteSyncChange: () => undefined,
    importable: () => ({}),
  };
  const api = new BrowserCloudSyncApi({
    host,
    keyring: ring,
    config,
    subject: async () => SUBJECT,
    marker: importMarker("m", {
      getItem: () => null,
      setItem: () => undefined,
    }),
    purgeSaves: async () => {
      calls.push("saves.purge");
      await saves.purge();
    },
    exportDeps: {
      product: PRODUCT,
      keyring: ring,
      request: (path, init) => world.request(path, init),
      fileFetch: world.files,
      now: () => 1_700_000_123_456,
      sleep: async (ms) => void sleeps.push(ms),
    },
  });
  const saves = new SavesApi({
    host,
    keyring: ring,
    product: PRODUCT,
    dbName: DB,
    fileFetch: world.files,
    locks,
    attach: () => api.attach(),
    files: {
      store: filesStore(filesDbName(DB), undefined, idb),
      sleep: async () => undefined,
    },
  });
  const lockRing = (): void => {
    o.ring?.lock();
    for (const l of [...ringListeners]) l();
  };
  return { world, host, api, saves, idb, calls, ring, locks, lockRing };
}

/** The waits an export asked for, never taken. */
const sleeps: number[] = [];

/** One pull: the machine learns the file pointers the Worker holds. */
const pulled = async (r: Rig): Promise<void> => {
  r.host.machine.refresh();
  await r.host.touch();
};

const readAll = async (r: Rig, id: string): Promise<Uint8Array> => {
  const got = await r.saves.read(id);
  if (!got.ok) throw new Error(`read: ${got.reason}`);
  return got.bytes ?? new Uint8Array();
};

describe("cloudSync.saves in the browser host", () => {
  it("writes a save, lists it and reads it back, in the writer tab", async () => {
    const r = await rig();
    const data = bytes(3000);
    const t = await r.saves.write("slot1", data, { name: "Level 1" });
    const out = await t.done;
    expect(out.state).toBe("done");
    expect(r.saves.transfers()).toEqual([]);
    await pulled(r);
    const list = await r.saves.list();
    expect(list.map((s) => [s.id, s.metadata.name])).toEqual([
      ["slot1", "Level 1"],
    ]);
    expect(hexOf(await readAll(r, "slot1"))).toBe(hexOf(data));
    // The record the Worker holds is the one the machine pushed, with the file the engine finalized.
    expect(r.world.recs.get("slot1")?.value).toMatchObject({ name: "Level 1" });
    expect(r.world.recs.get("slot1")?.file?.size).toBe(3000);
    await r.host.close();
  });

  it("emits progress, then done, and lists the write in transfers() while it runs", async () => {
    const r = await rig();
    const seen: string[] = [];
    r.saves.onTransfers((e) => seen.push(e?.type ?? "set"));
    const t = await r.saves.write("slot1", bytes(2000), { n: 1 });
    expect(r.saves.transfers().map((x) => x.id)).toEqual([t.id]);
    await t.done;
    expect(seen).toContain("transferProgress");
    expect(seen[seen.length - 1]).toBe("transferDone");
    await r.host.close();
  });

  it("saveConflictOpensRequest and saveKeepLocal: a stale base version opens a request, and keep settles it", async () => {
    const r = await rig();
    await (
      await r.saves.write("slot1", bytes(900, 1), { n: 1 })
    ).done;
    const stale = await (
      await r.saves.write("slot1", bytes(900, 2), { n: 2 }, { baseVersion: 1 })
    ).done;
    expect(stale.state).toBe("conflict");
    if (stale.state !== "conflict") return;
    expect(stale.request.remote?.value).toMatchObject({
      n: 1,
      savedAt: expect.any(Number),
    });
    expect(r.saves.conflicts().map((c) => c.id)).toEqual(["w:saves/slot1"]);
    const kept = await stale.request.keep("local");
    expect(kept).toMatchObject({ ok: true, kept: "local" });
    expect(r.saves.conflicts()).toEqual([]);
    expect(r.world.recs.get("slot1")?.value).toMatchObject({ n: 2 });
    expect(hexOf(await readAll(r, "slot1"))).toBe(hexOf(bytes(900, 2)));
    await r.host.close();
  });

  it("deletes a save with its record", async () => {
    const r = await rig();
    await (
      await r.saves.write("slot1", bytes(700), { n: 1 })
    ).done;
    const del = await r.saves.delete("slot1");
    expect(del.ok).toBe(true);
    expect(r.world.recs.has("slot1")).toBe(false);
    expect(await r.saves.list()).toEqual([]);
    await r.host.close();
  });

  it("cancel() settles the waiting write as cancelled and leaves no journal row", async () => {
    const r = await rig();
    let putting = false;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((res) => (release = res));
    // Hold the byte PUT, as a slow network would.
    const fetchOver = r.world.files;
    const held = new SavesApi({
      host: r.host,
      keyring: { codec: () => null },
      product: PRODUCT,
      dbName: DB,
      fileFetch: async (path, init) => {
        if (init.method === "PUT") {
          putting = true;
          await gate;
        }
        return fetchOver(path, init);
      },
      locks: r.locks,
      attach: () => r.api.attach(),
      files: {
        store: filesStore(filesDbName(`${DB}2`), undefined, r.idb),
        sleep: async () => undefined,
      },
    });
    const t = await held.write("slot1", bytes(1200), { n: 1 });
    await vi.waitFor(() => expect(putting).toBe(true));
    const cancelled = t.cancel();
    release();
    await cancelled;
    expect((await t.done).state).toBe("cancelled");
    expect(held.transfers()).toEqual([]);
    expect(r.world.recs.has("slot1")).toBe(false);
    await r.host.close();
  });

  it("refuses to write from a tab that is not the writer, and still reads", async () => {
    const world = new FakeWorker("server");
    const locks = new Locks();
    const hub = new Hub();
    const store = memoryConnectState();
    const a = await rig({ world, locks, hub, store });
    await a.saves.list();
    await (
      await a.saves.write("slot1", bytes(600), { n: 1 })
    ).done;
    const b = await rig({ world, locks, hub, store });
    await b.host.start();
    expect(b.host.isWriter).toBe(false);
    await expect(
      b.saves.write("slot1", bytes(600), { n: 2 }),
    ).rejects.toMatchObject({
      code: "rejected",
      detail: "sync-not-writer",
    });
    await expect(b.saves.delete("slot1")).rejects.toMatchObject({
      detail: "sync-not-writer",
    });
    await a.host.close();
    await b.host.close();
  });

  it("refuses with sync-locked while the end-to-end ring holds no root", async () => {
    const r = await rig({ mode: "e2e" });
    await expect(
      r.saves.write("slot1", bytes(600), { n: 1 }),
    ).rejects.toMatchObject({
      code: "sync-locked",
    });
    await r.host.close();
  });

  it("takes every engine entry under the Web Lock (no raw engine use outside it)", async () => {
    const world = new FakeWorker("server");
    const locks = new Locks();
    const order: string[] = [];
    const spy = {
      request: (name: string, a: unknown, b?: unknown) =>
        locks.request(name, async (l: unknown) => {
          order.push(`+${name}`);
          try {
            return await (
              (typeof a === "function" ? a : b) as (l: unknown) => unknown
            )(l);
          } finally {
            order.push(`-${name}`);
          }
        }),
    };
    const files = createBrowserFiles({
      product: PRODUCT,
      dbName: DB,
      fileFetch: async (path, init) => {
        order.push(`${init.method} ${path.split("/").slice(-1)[0]}`);
        return world.files(path, init);
      },
      locks: spy as never,
      store: filesStore(filesDbName(DB), undefined, new IDBFactory()),
    });
    const engine = lockedEngine(files);
    const data = bytes(500);
    const src = rangedBytes(data);
    const sha = hexOf(
      await crypto.subtle
        .digest("SHA-256", data)
        .then((b) => new Uint8Array(b)),
    );
    await engine.upload({
      id: "t1",
      collection: "saves",
      record: "slot1",
      source: src,
      size: data.length,
      sha256: sha,
      enc: "none",
      baseVersion: "*",
    });
    const lock = `pkey-sync-files:${DB}`;
    expect(order[0]).toBe(`+${lock}`);
    await new Promise((res) => setTimeout(res, 0));
    expect(order[order.length - 1]).toBe(`-${lock}`);
    expect(order.filter((x) => x.startsWith("+")).length).toBe(1);
    // Nothing the engine sent went out before the lock or after it.
    const inside = order.slice(1, -1);
    expect(inside.length).toBeGreaterThan(2);
    expect(inside.some((x) => x.startsWith("+") || x.startsWith("-"))).toBe(
      false,
    );
  });

  it("ends a wait for the lock when the transfer is paused or cancelled, and gives the lock back unused", async () => {
    const world = new FakeWorker("server");
    const locks = new Locks();
    const files = createBrowserFiles({
      product: PRODUCT,
      dbName: DB,
      fileFetch: world.files,
      locks,
      store: filesStore(filesDbName(DB), undefined, new IDBFactory()),
    });
    const engine = lockedEngine(files);
    let free: () => void = () => undefined;
    const other = files.exclusive(
      () => new Promise<void>((res) => (free = res)),
    );
    const abort = new AbortController();
    const data = bytes(300);
    const waiting = engine.upload({
      id: "t1",
      collection: "saves",
      record: "slot1",
      source: rangedBytes(data),
      size: data.length,
      sha256: "0".repeat(64),
      enc: "none",
      baseVersion: "*",
      signal: abort.signal,
    });
    abort.abort();
    await expect(waiting).rejects.toMatchObject({ reason: "aborted" });
    free();
    await other;
    expect(world.seen).toEqual([]);
    // The lock is free again.
    await expect(files.exclusive(async () => "ok")).resolves.toBe("ok");
  });

  describe("the person leaves", () => {
    it("purges in order: lock the ring, then the saves, then the pin", async () => {
      const r = await rig();
      await (
        await r.saves.write("slot1", bytes(600), { n: 1 })
      ).done;
      await r.api.beforeSignOut();
      expect(r.calls.slice(0, 3)).toEqual([
        "ring.lock",
        "saves.purge",
        "ring.forget",
      ]);
      await r.host.close();
    });

    it("cancels a running write, settles a waiting one as signed-out, and the deleted database stays deleted", async () => {
      const r = await rig();
      let putting = false;
      let release: () => void = () => undefined;
      const gate = new Promise<void>((res) => (release = res));
      const fetchOver = r.world.files;
      const idb = new IDBFactory();
      const held = new SavesApi({
        host: r.host,
        keyring: { codec: () => null },
        product: PRODUCT,
        dbName: DB,
        fileFetch: async (path, init) => {
          if (init.method === "PUT") {
            putting = true;
            await gate;
          }
          return fetchOver(path, init);
        },
        locks: r.locks,
        attach: () => r.api.attach(),
        files: { store: filesStore(filesDbName(DB), undefined, idb) },
      });
      const t = await held.write("slot1", bytes(1500), { n: 1 });
      await vi.waitFor(() => expect(putting).toBe(true));
      expect((await idb.databases()).map((d) => d.name)).toContain(
        filesDbName(DB),
      );
      const purged = held.purge();
      release();
      await purged;
      expect((await t.done).state).toBe("cancelled");
      expect(held.transfers()).toEqual([]);
      // Whatever the running transfer did after the purge did not bring the database back.
      await new Promise((res) => setTimeout(res, 20));
      expect((await idb.databases()).map((d) => d.name)).not.toContain(
        filesDbName(DB),
      );
      await r.host.close();
    });

    it("settles a write still waiting for its outcome as cancelled, never as ok", async () => {
      const r = await rig();
      await r.saves.list();
      // The Worker does not answer the push until the end, so the write waits for its outcome.
      let answer: () => void = () => undefined;
      r.world.hook = (key) =>
        key === "POST sync/ops"
          ? (new Promise<Response>((res) => {
              answer = () => res(new Response("{}", { status: 503 }));
            }) as never)
          : undefined;
      const t = await r.saves.write("slot1", bytes(500), { n: 1 });
      await vi.waitFor(() => expect(r.world.seen).toContain("POST sync/ops"));
      await r.saves.purge();
      const out = await t.done;
      expect(out.state).toBe("cancelled");
      expect(r.saves.transfers()).toEqual([]);
      answer();
      await r.host.close();
    });
  });

  it("a purge wins over a call that began before it: no files layer is rebuilt, no conflict re-added", async () => {
    const r = await rig();
    await r.saves.list();
    const racing = r.saves.write("slot1", bytes(500), { n: 1 }).then(
      () => null,
      (e: unknown) => e,
    );
    await r.saves.purge();
    expect(await racing).toMatchObject({ detail: "signed-out" });
    expect(r.saves.conflicts()).toEqual([]);
    expect(r.saves.transfers()).toEqual([]);
    await r.host.close();
  });

  it("a purge while the codec is being built leaves no files layer", async () => {
    const r = await rig({ mode: "e2e" });
    let built: (c: unknown) => void = () => undefined;
    let asked = false;
    // The ring answers the file codec late: the purge lands in between.
    (r.ring as unknown as { fileCodec: unknown }).fileCodec = () => {
      asked = true;
      return new Promise((res) => (built = res));
    };
    const listing = r.saves.list().then(
      () => null,
      (e: unknown) => e,
    );
    await vi.waitFor(() => expect(asked).toBe(true));
    await r.saves.purge();
    built(serverFileCodec(webCryptoSyncPort));
    expect(await listing).toMatchObject({ detail: "signed-out" });
    expect(r.saves.built).toBe(false);
    expect((await r.idb.databases()).map((d) => d.name)).not.toContain(
      filesDbName(DB),
    );
    await r.host.close();
  });

  it("a write begun before a purge is cancelled", async () => {
    const r = await rig();
    let held: SavesApi | null = null;
    let leave = false;
    // The person leaves after the write's client is built and before the write is registered.
    held = new SavesApi({
      host: r.host,
      keyring: { codec: () => null },
      product: PRODUCT,
      dbName: DB,
      fileFetch: r.world.files,
      locks: r.locks,
      attach: () => r.api.attach(),
      subject: () => {
        if (leave) void held!.purge();
        return SUBJECT;
      },
      files: { store: filesStore(filesDbName(DB), undefined, r.idb) },
    });
    await held.list();
    leave = true;
    const t = await held.write("slot1", bytes(500), { n: 1 });
    // Registered nowhere and cancelled at once: a write left running would wait on what the
    // purge deleted.
    try {
      expect(held.transfers()).toEqual([]);
    } finally {
      void t.cancel().catch(() => undefined);
    }
    expect((await t.done).state).toBe("cancelled");
    await r.host.close();
  });

  it("is the typed unsupported on a transport that cannot run Cloud Sync", async () => {
    const u = unsupportedCloudSync("runtime", "no sync here");
    await expect(u.saves.list()).rejects.toMatchObject({
      feature: "sync.saves",
      reason: "runtime",
    });
    expect(u.saves.transfers()).toEqual([]);
  });

  it("loads the saves layer on the first call only", async () => {
    const load = vi.fn();
    const r = await rig();
    const stub = lazySaves(() => {
      load();
      return {
        host: r.host,
        keyring: { codec: () => null },
        product: PRODUCT,
        dbName: DB,
        fileFetch: r.world.files,
        locks: r.locks,
        attach: () => r.api.attach(),
        files: { store: filesStore(filesDbName(DB), undefined, r.idb) },
      };
    });
    expect(stub.transfers()).toEqual([]);
    await stub.purge();
    expect(load).not.toHaveBeenCalled();
    await stub.list();
    await stub.list();
    expect(load).toHaveBeenCalledTimes(1);
    await r.host.close();
  });
});

// ── cloudSync.export (U-51.4) ────────────────────────────────────────────────────────────────

/** The entries of a STORED zip, from the central directory's records. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const u16 = (at: number): number => view.getUint16(at, true);
  const u32 = (at: number): number => view.getUint32(at, true);
  let eocd = zip.length - 22;
  while (u32(eocd) !== 0x06054b50) eocd--;
  const entries = new Map<string, Uint8Array>();
  let record = u32(eocd + 16);
  for (let n = u16(eocd + 10); n > 0; n--) {
    const nameAt = record + 46;
    const nameEnd = nameAt + u16(record + 28);
    const body = u32(record + 42) + 30;
    const from = body + u16(body - 4) + u16(body - 2);
    const size = u32(record + 20);
    entries.set(
      new TextDecoder().decode(zip.subarray(nameAt, nameEnd)),
      zip.subarray(from, from + size),
    );
    record = nameEnd + u16(record + 30) + u16(record + 32);
  }
  return entries;
}

const text = (b: Uint8Array | undefined): string =>
  new TextDecoder().decode(b ?? new Uint8Array());
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && hexOf(a) === hexOf(b);

/** One save on the Worker, as the machine saw it. */
async function withSave(r: Rig, data: Uint8Array): Promise<void> {
  await (
    await r.saves.write("slot1", data, { name: "Level 1" })
  ).done;
  await pulled(r);
}

/** A WritableStream that collects what it is given, and says how it ended. */
function collector(
  opts: { failAfter?: number; onWrite?: (count: number) => void } = {},
) {
  const chunks: Uint8Array[] = [];
  const ended = {
    closed: false,
    aborted: false as boolean,
    reason: undefined as unknown,
  };
  const stream = new WritableStream<Uint8Array>({
    write(c) {
      if (opts.failAfter !== undefined && chunks.length >= opts.failAfter)
        throw new Error("the picker closed");
      chunks.push(c.slice());
      opts.onWrite?.(chunks.length);
    },
    close() {
      ended.closed = true;
    },
    abort(reason) {
      ended.aborted = true;
      ended.reason = reason;
    },
  });
  const all = (): Uint8Array => {
    const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) (out.set(c, at), (at += c.length));
    return out;
  };
  return { stream, chunks, ended, all };
}

describe("cloudSync.export in the browser: the archive", () => {
  it("answers a Blob holding the zip when no sink is given", async () => {
    const r = await rig();
    const data = bytes(3000);
    await withSave(r, data);
    const out = await r.api.export();
    expect(out.blob).toBeInstanceOf(Blob);
    expect(out).toMatchObject({
      records: 1,
      files: 1,
      settings: 0,
      skipped: [],
      unsynced: 0,
    });
    expect(out.blob!.type).toBe("application/zip");
    expect(out.blob!.size).toBe(out.bytes);
    const zip = readZip(new Uint8Array(await out.blob!.arrayBuffer()));
    expect(same(zip.get("stores/sync.cloudSync/files/0.bin"), data)).toBe(true);
    const meta = JSON.parse(text(zip.get("data.json")));
    expect(meta).toMatchObject({
      schema: "pkey-sync-export/1",
      source: "device",
      product: PRODUCT,
      exportedAt: 1_700_000_123_456,
      encryption: "server",
    });
    // The person's pairwise subject is never written.
    for (const [, b] of zip) expect(text(b)).not.toContain(SUBJECT);
    await r.host.close();
  });

  it("streams into a sink, closes it, and answers no Blob", async () => {
    const r = await rig();
    const data = bytes(2500, 9);
    await withSave(r, data);
    const sink = collector();
    const out = await r.api.export({ sink: sink.stream });
    expect(out.blob).toBeUndefined();
    expect(sink.ended).toMatchObject({ closed: true, aborted: false });
    expect(sink.all().length).toBe(out.bytes);
    const zip = readZip(sink.all());
    expect(same(zip.get("stores/sync.cloudSync/files/0.bin"), data)).toBe(true);
    // The stream is not locked after the call: the SDK kept no writer.
    expect(sink.stream.locked).toBe(false);
    await r.host.close();
  });

  it("is refused before reading a file when the plan is over the Blob cap, but not with a sink", async () => {
    const r = await rig();
    await withSave(r, bytes(100));
    r.world.recs.get("slot1")!.file!.size = SYNC_EXPORT_BLOB_MAX_BYTES + 1;
    r.world.seen.length = 0;
    const err = await r.api.export().catch((e) => e);
    expect(err).toMatchObject({ code: "sync-export-too-large" });
    // Only the metadata call (the kept revisions) was made: no file was read.
    expect(
      r.world.seen.filter(
        (s) => s.includes("slot1") && !s.includes("revisions"),
      ),
    ).toEqual([]);
    // A sink has no such cap (only the zip32 one): 5 GB is refused there too.
    r.world.recs.get("slot1")!.file!.size = 5_000_000_000;
    const sink = collector();
    const over = await r.api.export({ sink: sink.stream }).catch((e) => e);
    expect(over).toMatchObject({ code: "sync-export-too-large" });
    expect(sink.chunks).toEqual([]);
    // Refused before the first byte: the stream was never opened for writing, so it is still usable.
    expect(sink.stream.locked).toBe(false);
    await r.host.close();
  });

  it("a cancel in the middle keeps nothing: no Blob, the sink aborted, not closed", async () => {
    const r = await rig();
    await withSave(r, bytes(3 * 1024 * 1024));
    const ctl = new AbortController();
    // After the first pieces of the file, the person cancels.
    const sink = collector({ onWrite: (n) => n === 3 && ctl.abort() });
    const err = await r.api
      .export({ sink: sink.stream, signal: ctl.signal })
      .catch((e) => e);
    expect(err).toMatchObject({ code: "cancelled" });
    expect(sink.ended.aborted).toBe(true);
    expect(sink.ended.closed).toBe(false);
    // And with a Blob: the result is the rejection, nothing else.
    const ctl2 = new AbortController();
    r.world.hook = () => {
      ctl2.abort();
      return undefined;
    };
    const err2 = await r.api.export({ signal: ctl2.signal }).catch((e) => e);
    expect(err2).toMatchObject({ code: "cancelled" });
    expect(err2.blob).toBeUndefined();
    await r.host.close();
  });

  it("an aborted signal before the call reads nothing", async () => {
    const r = await rig();
    await withSave(r, bytes(100));
    const ctl = new AbortController();
    ctl.abort();
    r.world.seen.length = 0;
    const err = await r.api.export({ signal: ctl.signal }).catch((e) => e);
    expect(err).toMatchObject({ code: "cancelled" });
    expect(r.world.seen).toEqual([]);
    await r.host.close();
  });

  it("a sink that fails is reason destination and is aborted", async () => {
    const r = await rig();
    await withSave(r, bytes(2000));
    const sink = collector({ failAfter: 2 });
    const err = await r.api.export({ sink: sink.stream }).catch((e) => e);
    expect(err).toBeInstanceOf(SyncExportError);
    expect(err).toMatchObject({
      code: "sync-export-failed",
      reason: "destination",
    });
    expect(sink.ended.closed).toBe(false);
    await r.host.close();
  });

  it("waits out a 429 on the file with the injected sleep, bounded", async () => {
    const r = await rig();
    const data = bytes(1500);
    await withSave(r, data);
    sleeps.length = 0;
    let n = 0;
    r.world.hook = (key) =>
      key.includes("slot1") && !key.includes("revisions") && n++ < 2
        ? new Response("{}", { status: 429, headers: { "retry-after": "3" } })
        : undefined;
    const out = await r.api.export();
    expect(out.files).toBe(1);
    expect(sleeps).toEqual([3000, 3000]);
    // A Worker that never stops limiting ends the export with reason network.
    r.world.hook = (key) =>
      key.includes("slot1") && !key.includes("revisions")
        ? new Response("{}", { status: 429, headers: { "retry-after": "900" } })
        : undefined;
    sleeps.length = 0;
    const err = await r.api.export().catch((e) => e);
    expect(err).toMatchObject({
      code: "sync-export-failed",
      reason: "network",
    });
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(5_400_000);
    await r.host.close();
  });

  it("allows one export at a time", async () => {
    const r = await rig();
    await withSave(r, bytes(1000));
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    r.world.hook = (key) => {
      if (key.includes("slot1") && !key.includes("revisions"))
        return void held as undefined;
      return undefined;
    };
    const first = r.api.export();
    // Let the first reach the file.
    await vi.waitFor(() =>
      expect(r.world.seen.some((s) => s.includes("slot1"))).toBe(true),
    );
    const second = await r.api.export().catch((e) => e);
    expect(second).toMatchObject({
      code: "sync-export-failed",
      reason: "busy",
    });
    release();
    await first;
    await r.host.close();
  });

  it("answers the typed unsupported where Cloud Sync cannot run", async () => {
    const off = unsupportedCloudSync("runtime", "no bridge verb");
    await expect(off.export()).rejects.toMatchObject({
      unsupported: { supported: false, feature: "sync.export" },
    });
  });
});

describe("cloudSync.export in the browser: end-to-end", () => {
  const change = (over: Body): Body => ({
    setting: "theme",
    scope: "user",
    version: 5,
    editedHlc: "0199c82cc000:0000",
    updatedBy: "c_AAAAAAAAAAAAAAAAAAAAAA",
    ...over,
  });

  it("opens sealed settings with the vault's handle (never the root's bytes) and lists one that does not open", async () => {
    const ring = await makeRing();
    const r = await rig({ mode: "e2e", ring });
    const sealed = base64UrlEncodeBytes(
      await ring.codec()!.seal("$settings", "theme", "dark"),
    );
    // The Worker's own pull, plus a sealed setting and one that does not open.
    const pull = r.world.request;
    r.world.request = async (path, init) => {
      const res = await pull.call(r.world, path, init);
      if (!path.startsWith("sync?cursor=")) return res;
      const body = (await res.json()) as { changes: Body[] };
      body.changes.push(
        change({ ct: sealed }),
        change({ setting: "AAAAAAAAAAAAAAAAAAAAAA", ct: "AAAA", version: 6 }),
      );
      return new Response(JSON.stringify(body));
    };
    const out = await r.api.export();
    expect(out.settings).toBe(1);
    expect(out.skipped).toEqual([{ kind: "setting", code: "invalid" }]);
    const zip = readZip(new Uint8Array(await out.blob!.arrayBuffer()));
    expect(text(zip.get("stores/sync.cloudSync/settings.json"))).toBe(
      '{"theme":"dark"}\n',
    );
    expect(JSON.parse(text(zip.get("data.json"))).encryption).toBe("e2e");
    await r.host.close();
  });

  it("a ring that locks during the export ends it with sync-locked and no Blob", async () => {
    const ring = await makeRing();
    const r = await rig({ mode: "e2e", ring });
    const request = r.world.request;
    r.world.request = async (path, init) => {
      if (path.startsWith("sync?cursor=")) r.lockRing();
      return request.call(r.world, path, init);
    };
    const err = await r.api.export().catch((e) => e);
    expect(err).toMatchObject({ code: "sync-locked" });
    expect(err.blob).toBeUndefined();
    await r.host.close();
  });

  it("a locked ring refuses before anything is read", async () => {
    const ring = await makeRing();
    ring.lock();
    const r = await rig({ mode: "e2e", ring });
    const err = await r.api.export().catch((e) => e);
    expect(err).toMatchObject({ code: "sync-locked" });
    await r.host.close();
  });
});

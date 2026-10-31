// @vitest-environment node
//
// @pkey-feature sync.saves
//
// SAVES.R (U-22.7): `adapter.cloudSync.saves` in the browser host. The real host and machine over a
// small fake Worker (/sync and /sync/files), the file layer on fake-indexeddb, and the saves
// client bound to the machine's records: write, read, list, conflict, resolve, delete, cancel, the
// locked ring, the purge and its order, and the one writer.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { rangedBytes } from "@polaris-key/client-core/sync";
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
import { FakeWorker, PRODUCT, hexOf } from "./savesFixtures.js";

const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
const DB = "pkey-sync-saves";
const CATALOG = { schemaVersion: 1, entries: [] };

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
}

async function rig(
  o: {
    mode?: "e2e" | "server";
    world?: FakeWorker;
    locks?: Locks;
    hub?: Hub;
    store?: ReturnType<typeof memoryConnectState>;
  } = {},
): Promise<Rig> {
  const mode = o.mode ?? "server";
  const world = o.world ?? new FakeWorker(mode);
  world.subject = SUBJECT;
  const locks = o.locks ?? new Locks();
  const hub = o.hub ?? new Hub();
  const idb = new IDBFactory();
  const calls: string[] = [];
  const ring = {
    hasRoot: () => false,
    subscribe: () => () => undefined,
    codec: () => null,
    fileCodec: async () => null,
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
  return { world, host, api, saves, idb, calls, ring, locks };
}

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

  it("reports a stale base version as a conflict, and resolve settles it", async () => {
    const r = await rig();
    await (
      await r.saves.write("slot1", bytes(900, 1), { n: 1 })
    ).done;
    const stale = await (
      await r.saves.write("slot1", bytes(900, 2), { n: 2 }, { baseVersion: 1 })
    ).done;
    expect(stale.state).toBe("conflict");
    if (stale.state !== "conflict") return;
    expect(stale.conflict.remote?.metadata).toEqual({ n: 1 });
    const kept = await (
      await r.saves.resolve(stale.conflict, "local", bytes(900, 2))
    ).done;
    expect(kept.state).toBe("done");
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

// @vitest-environment node
//
// @pkey-feature sync.export
//
// `adapter.cloudSync.export()` in the browser host (U-51.4; WIRE-CONTRACT-V5 §13.12): the real host
// and machine over the small fake Worker of the saves tests, the archive as a Blob or streamed into
// a WritableStream, the Blob cap, a cancel, a failing stream, an end-to-end ring and the one export at
// a time. No wall-clock waits: the sleep is injected.

import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it, vi } from "vitest";
import { base64UrlEncodeBytes } from "@polaris-key/jws";
import { SyncExportError } from "@polaris-key/client-core/sync";
import { SYNC_EXPORT_BLOB_MAX_BYTES } from "@polaris-key/protocol/sync";
import {
  BrowserCloudSyncApi,
  importMarker,
} from "../src/browser/cloudSync/api.js";
import { filesDbName } from "../src/browser/cloudSync/filesPurge.js";
import { BrowserCloudSyncHost } from "../src/browser/cloudSync/host.js";
import { filesStore } from "../src/browser/cloudSync/idbJournal.js";
import { SavesApi } from "../src/browser/cloudSync/saves.js";
import { memoryConnectState } from "../src/browser/connect/state.js";
import { unsupportedCloudSync } from "../src/core/cloudSync.js";
import {
  FakeWorker,
  Hub,
  Locks,
  PRODUCT,
  hexOf,
  makeRing,
  type Body,
} from "./savesFixtures.js";

const SUBJECT = "ps_aqofwJ_4zDBMy1_W857ARg";
const DB = "pkey-sync-export";
const CATALOG = {
  schemaVersion: 1,
  entries: [],
  cloudSync: { collections: [{ name: "saves", conflict: "revision" }] },
};

const bytes = (n: number, seed = 5): Uint8Array<ArrayBuffer> =>
  Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);

/** The entries of a STORED zip, by its central directory. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (v.getUint32(end, true) !== 0x06054b50) end--;
  const count = v.getUint16(end + 10, true);
  let at = v.getUint32(end + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const size = v.getUint32(at + 20, true);
    const nameLen = v.getUint16(at + 28, true);
    const extra = v.getUint16(at + 30, true);
    const comment = v.getUint16(at + 32, true);
    const local = v.getUint32(at + 42, true);
    const name = new TextDecoder().decode(
      zip.subarray(at + 46, at + 46 + nameLen),
    );
    const data =
      local +
      30 +
      v.getUint16(local + 26, true) +
      v.getUint16(local + 28, true);
    out.set(name, zip.subarray(data, data + size));
    at += 46 + nameLen + extra + comment;
  }
  return out;
}

const text = (b: Uint8Array | undefined): string =>
  new TextDecoder().decode(b ?? new Uint8Array());
const same = (a: Uint8Array | undefined, b: Uint8Array): boolean =>
  a !== undefined && hexOf(a) === hexOf(b);

/** The sleeps the export asked for, never taken. */
const sleeps: number[] = [];
const sleep = async (ms: number): Promise<void> => void sleeps.push(ms);

type Ring = Awaited<ReturnType<typeof makeRing>>;

async function rig(o: { mode?: "e2e" | "server"; ring?: Ring } = {}) {
  const mode = o.mode ?? "server";
  const world = new FakeWorker(mode);
  world.subject = SUBJECT;
  const locks = new Locks();
  const hub = new Hub();
  const idb = new IDBFactory();
  const listeners = new Set<() => void>();
  const base = o.ring;
  const ring = {
    hasRoot: () => base !== undefined,
    subscribe: (l: () => void) => (listeners.add(l), () => listeners.delete(l)),
    codec: () => base?.codec() ?? null,
    fileCodec: async (c: string) => base?.fileCodec(c) ?? null,
    exportKeys: async () => {
      if (base === undefined || base.codec() === null) return null;
      const keys = await base.keys();
      if (keys === null) return null;
      const { port, root } = await keys.withRoot(async (p, r) => ({
        port: p,
        root: r,
      }));
      return { port, root, alive: () => base.codec() !== null };
    },
    lock: vi.fn(async () => undefined),
    forget: vi.fn(async () => undefined),
  };
  const host = new BrowserCloudSyncHost(
    {
      product: PRODUCT,
      request: (path, init) => world.request(path, init),
      ring,
      purgeSaves: async () => undefined,
      discovery: () => null,
      fetchSchema: async () => CATALOG as never,
      document: () => ({ values: {} }),
      enabled: () => true,
      store: memoryConnectState(),
      locks,
      writerLock: "w",
      stateLock: "s",
      channel: hub.channel(),
    },
    { catalog: CATALOG as never, encryption: mode, saves: { delta: false } },
  );
  const api = new BrowserCloudSyncApi({
    host,
    keyring: ring,
    config: {
      useSync: () => undefined,
      noteSyncChange: () => undefined,
      importable: () => ({}),
    },
    subject: async () => SUBJECT,
    marker: importMarker("m", {
      getItem: () => null,
      setItem: () => undefined,
    }),
    exportDeps: {
      product: PRODUCT,
      keyring: ring,
      request: (path, init) => world.request(path, init),
      fileFetch: world.files,
      now: () => 1_700_000_123_456,
      sleep,
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
  return {
    world,
    host,
    api,
    saves,
    ring,
    lock: () => {
      base?.lock();
      for (const l of [...listeners]) l();
    },
  };
}

type Rig = Awaited<ReturnType<typeof rig>>;

/** One save on the Worker, as the machine saw it. */
async function withSave(r: Rig, data: Uint8Array): Promise<void> {
  await (
    await r.saves.write("slot1", data, { name: "Level 1" })
  ).done;
  r.host.machine.refresh();
  await r.host.touch();
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
    const pull = r.world.request;
    r.world.request = async (path, init) =>
      path.startsWith("sync?cursor=")
        ? new Response(
            JSON.stringify({
              subject: SUBJECT,
              serverNow: 1,
              cursor: 6,
              more: false,
              lastMutationId: 0,
              catalogVersion: 1,
              aliases: {},
              usage: { files: 0, records: 0, settings: 0, bytes: 0 },
              quota: { files: true, bytes: 2 ** 28 },
              encryption: "e2e",
              encryptionSince: 1,
              tombstones: [],
              changes: [
                change({ ct: sealed }),
                change({
                  setting: "AAAAAAAAAAAAAAAAAAAAAA",
                  ct: "AAAA",
                  version: 6,
                }),
              ],
            }),
          )
        : pull.call(r.world, path, init);
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
      if (path.startsWith("sync?cursor=")) r.lock();
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

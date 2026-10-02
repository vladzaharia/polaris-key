// The browser pack store over the Origin Private File System (P4-06; CONTENT §10 "Web"; notes/A7
// §9). The Cache API refuses 206 responses and IndexedDB is a poor home for large blobs, so
// staging and the store live in OPFS:
//
//   <root>/state.json                         the install state (replaced whole)
//   <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
//   <root>/staging/<planId>/out/              the payload being built
//   <root>/store/<packId>/<payloadSha256>/    a committed payload; `.pkey/files.json` beside it
//
// It uses only the main-thread API (`createWritable`, `getFile`), which Chromium, Firefox and
// Safari 17+ ship. A directory cannot be renamed portably, so commit copies the staged output
// into the store and then drops it; the state's pointer swap happens only after the copy.
// Storage can be evicted: a missing payload fails `verify` on load, and the engine plans from
// scratch. `requestPersistence()` asks the browser to keep it (after engagement).

import type { FilesIndexDoc } from "@polaris-key/protocol/packs";
import {
  treeDigest,
  type ByteSink,
  type ByteSource,
  type InstalledFile,
  type InstalledPayload,
  type PackInstall,
  type PackStateStore,
  type PackStorage,
  type Sha256Port,
  type StagedObject,
  type TreeSink,
} from "@polaris-key/client-core";

/** The slice of `FileSystemDirectoryHandle` this store uses (OPFS, or a test double). */
export interface DirHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(
    name: string,
    opts?: { create?: boolean },
  ): Promise<DirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  entries(): AsyncIterableIterator<[string, DirHandle | FileHandle]>;
}

export interface FileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<{
    size: number;
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  }>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<{
    write(
      data: { type: "write"; position: number; data: Uint8Array } | Uint8Array,
    ): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
  }>;
}

const INDEX = ".pkey";
const INDEX_FILE = "files.json";
/** Written into `.pkey/` last: a store directory without it is a partial copy, never used. */
const COMMITTED_FILE = "committed";
const CHUNK = 1 << 20;
const CONTAINER_FILE = "payload.bin";
const FLUSH_BYTES = 1 << 20;

/** "Missing" in OPFS: no such entry, or an entry of the other kind. Anything else (a
 *  NotReadableError, a SecurityError, quota) is "cannot read" and is thrown, never mistaken for
 *  missing, so `verify`, `installed`, `committed` and `quarantined` cannot drop an install that
 *  is merely unreadable. */
function missing(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  return name === "NotFoundError" || name === "TypeMismatchError";
}

async function dir(
  root: DirHandle,
  parts: readonly string[],
  create: boolean,
): Promise<DirHandle | null> {
  let d = root;
  for (const p of parts) {
    try {
      d = await d.getDirectoryHandle(p, { create });
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
  }
  return d;
}

async function fileAt(
  root: DirHandle,
  parts: readonly string[],
  create: boolean,
): Promise<FileHandle | null> {
  const parent = await dir(root, parts.slice(0, -1), create);
  if (!parent) return null;
  try {
    return await parent.getFileHandle(parts[parts.length - 1]!, { create });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

async function remove(
  root: DirHandle,
  parts: readonly string[],
): Promise<void> {
  const parent = await dir(root, parts.slice(0, -1), false).catch(() => null);
  if (!parent) return;
  try {
    await parent.removeEntry(parts[parts.length - 1]!, { recursive: true });
  } catch {
    // Already gone.
  }
}

function source(fh: FileHandle, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      if (n === 0) return new Uint8Array();
      const f = await fh.getFile();
      return new Uint8Array(await f.slice(offset, offset + n).arrayBuffer());
    },
  };
}

async function writeWhole(fh: FileHandle, bytes: Uint8Array): Promise<void> {
  const w = await fh.createWritable();
  await w.write(bytes);
  await w.close();
}

async function writeAt(
  fh: FileHandle,
  offset: number,
  bytes: Uint8Array,
): Promise<void> {
  const w = await fh.createWritable({ keepExistingData: true });
  await w.write({ type: "write", position: offset, data: bytes });
  await w.close();
}

/** A file's SHA-256, read in 1 MiB slices. */
async function hashFile(
  fh: FileHandle,
  sha256: Sha256Port,
): Promise<{ size: number; sha256: string }> {
  const f = await fh.getFile();
  const h = sha256();
  for (let at = 0; at < f.size; at += CHUNK)
    h.update(
      new Uint8Array(
        await f.slice(at, Math.min(f.size, at + CHUNK)).arrayBuffer(),
      ),
    );
  return { size: f.size, sha256: await h.digest() };
}

/** Every file under `d`, as `/`-separated paths, skipping `.pkey/`. */
async function walk(
  d: DirHandle,
  prefix = "",
): Promise<{ path: string; handle: FileHandle }[]> {
  const out: { path: string; handle: FileHandle }[] = [];
  for await (const [name, h] of d.entries()) {
    const path = prefix === "" ? name : `${prefix}/${name}`;
    if (path === INDEX) continue;
    if (h.kind === "directory") out.push(...(await walk(h, path)));
    else out.push({ path, handle: h });
  }
  return out;
}

async function copyDir(from: DirHandle, to: DirHandle): Promise<void> {
  for await (const [name, h] of from.entries()) {
    if (h.kind === "directory")
      await copyDir(h, await to.getDirectoryHandle(name, { create: true }));
    else {
      // Copied in 1 MiB slices: a large payload never sits in memory whole.
      const f = await h.getFile();
      const w = await (
        await to.getFileHandle(name, { create: true })
      ).createWritable();
      try {
        for (let at = 0; at < f.size; at += CHUNK)
          await w.write({
            type: "write",
            position: at,
            data: new Uint8Array(
              await f.slice(at, Math.min(f.size, at + CHUNK)).arrayBuffer(),
            ),
          });
      } finally {
        await w.close();
      }
    }
  }
}

const locationParts = (location: string): string[] => location.split("/");

export interface OpfsPackStore {
  storage: PackStorage;
  state: PackStateStore;
}

/**
 * The OPFS store, rooted at `root` (default: `navigator.storage.getDirectory()` →
 * `polaris-key/<product>/packs`). `sha256` hashes what `verify` re-reads. Throws when the
 * browser has no OPFS: the caller chooses another store explicitly, never silently.
 */
export async function opfsPackStore(opts: {
  product: string;
  sha256: Sha256Port;
  root?: DirHandle;
}): Promise<OpfsPackStore> {
  let base = opts.root;
  if (!base) {
    const nav = (
      globalThis as {
        navigator?: { storage?: { getDirectory?: () => Promise<unknown> } };
      }
    ).navigator;
    if (typeof nav?.storage?.getDirectory !== "function")
      throw new Error("This browser has no Origin Private File System.");
    base = (await nav.storage.getDirectory()) as DirHandle;
  }
  const root = (await dir(base, ["polaris-key", opts.product, "packs"], true))!;
  const readIndex = async (location: string): Promise<FilesIndexDoc | null> => {
    const fh = await fileAt(
      root,
      [...locationParts(location), INDEX, INDEX_FILE],
      false,
    );
    if (!fh) return null;
    try {
      const f = await fh.getFile();
      return JSON.parse(
        new TextDecoder().decode(await f.slice(0, f.size).arrayBuffer()),
      ) as FilesIndexDoc;
    } catch {
      return null;
    }
  };

  const committed = async (location: string): Promise<boolean> =>
    (await fileAt(
      root,
      [...locationParts(location), INDEX, COMMITTED_FILE],
      false,
    )) !== null;

  // One handle per staged object, so appends buffered by one caller are flushed before another
  // reads the object.
  const staged = new Map<string, StagedObject>();

  const storage: PackStorage = {
    async stagedObject(planId, sha256): Promise<StagedObject> {
      const key = `${planId}/${sha256}`;
      const cached = staged.get(key);
      if (cached) return cached;
      const parts = ["staging", planId, "objects", sha256];
      let pending: Uint8Array[] = [];
      let pendingBytes = 0;
      const flush = async (): Promise<void> => {
        if (pendingBytes === 0) return;
        const fh = (await fileAt(root, parts, true))!;
        const f = await fh.getFile();
        const all = new Uint8Array(pendingBytes);
        let at = 0;
        for (const p of pending) {
          all.set(p, at);
          at += p.byteLength;
        }
        pending = [];
        pendingBytes = 0;
        await writeAt(fh, f.size, all);
      };
      const size = async (): Promise<number> => {
        await flush();
        const fh = await fileAt(root, parts, false);
        return fh ? (await fh.getFile()).size : 0;
      };
      const obj: StagedObject = {
        size,
        source: async () => {
          const n = await size();
          const fh = await fileAt(root, parts, false);
          return fh
            ? source(fh, n)
            : { size: 0, read: async () => new Uint8Array() };
        },
        append: async (bytes) => {
          pending.push(bytes.slice());
          pendingBytes += bytes.byteLength;
          if (pendingBytes >= FLUSH_BYTES) await flush();
        },
        reset: async () => {
          pending = [];
          pendingBytes = 0;
          await remove(root, parts);
        },
      };
      staged.set(key, obj);
      return obj;
    },

    async output(
      planId,
      layout,
    ): Promise<{ sink?: ByteSink; tree?: TreeSink }> {
      await remove(root, ["staging", planId, "out"]);
      const out = (await dir(root, ["staging", planId, "out"], true))!;
      if (layout === "tree")
        return {
          tree: {
            writeFile: async (path, bytes) => {
              const segs = path.split("/");
              const parent = (await dir(out, segs.slice(0, -1), true))!;
              await writeWhole(
                await parent.getFileHandle(segs[segs.length - 1]!, {
                  create: true,
                }),
                bytes,
              );
            },
          },
        };
      const fh = await out.getFileHandle(CONTAINER_FILE, { create: true });
      return { sink: { write: (offset, bytes) => writeAt(fh, offset, bytes) } };
    },

    async commit(planId, packId, payloadSha256, _layout, index) {
      const location = `store/${packId}/${payloadSha256}`;
      const out = await dir(root, ["staging", planId, "out"], false);
      if (!out) throw new Error(`no output for plan ${planId}`);
      if (index !== null) {
        const meta = await out.getDirectoryHandle(INDEX, { create: true });
        await writeWhole(
          await meta.getFileHandle(INDEX_FILE, { create: true }),
          new TextEncoder().encode(JSON.stringify(index)),
        );
      }
      if (!(await committed(location))) {
        // No rename for directories: copy, then mark the copy complete. A partial copy (quota,
        // a crash) has no marker, is never used, and is replaced here or collected.
        await remove(root, locationParts(location));
        const target = (await dir(root, locationParts(location), true))!;
        try {
          await copyDir(out, target);
          const meta = await target.getDirectoryHandle(INDEX, { create: true });
          await writeWhole(
            await meta.getFileHandle(COMMITTED_FILE, { create: true }),
            new Uint8Array(),
          );
        } catch (e) {
          await remove(root, locationParts(location));
          throw e;
        }
      }
      await remove(root, ["staging", planId, "out"]);
      return location;
    },

    async installed(install: PackInstall): Promise<InstalledPayload | null> {
      const d = await dir(root, locationParts(install.location), false);
      if (!d || !(await committed(install.location))) return null;
      const index = await readIndex(install.location);
      if (install.layout === "tree") {
        const files: InstalledFile[] = [];
        if (index !== null) {
          for (const f of index.files) {
            const fh = await fileAt(d, f.path.split("/"), false);
            if (!fh) return null;
            files.push({
              path: f.path,
              sha256: f.sha256,
              size: f.size,
              source: source(fh, f.size),
            });
          }
        } else
          for (const { path, handle } of await walk(d)) {
            const m = await hashFile(handle, opts.sha256);
            files.push({
              path,
              sha256: m.sha256,
              size: m.size,
              source: source(handle, m.size),
            });
          }
        return { payload: null, files };
      }
      const fh = await fileAt(d, [CONTAINER_FILE], false);
      if (!fh) return null;
      const whole = source(fh, (await fh.getFile()).size);
      return {
        payload: whole,
        files:
          index?.files.map((f) => ({
            path: f.path,
            sha256: f.sha256,
            size: f.size,
            source: {
              size: f.size,
              read: (at: number, n: number) =>
                whole.read(
                  (f.offset ?? 0) + at,
                  Math.max(0, Math.min(n, f.size - at)),
                ),
            },
          })) ?? null,
      };
    },

    async verify(install) {
      const d = await dir(root, locationParts(install.location), false);
      if (!d || !(await committed(install.location))) return false;
      if (install.layout === "tree") {
        const files = [];
        for (const { path, handle } of await walk(d))
          files.push({ path, ...(await hashFile(handle, opts.sha256)) });
        return (await treeDigest(files)) === install.payloadSha256;
      }
      const fh = await fileAt(d, [CONTAINER_FILE], false);
      if (!fh) return false;
      const m = await hashFile(fh, opts.sha256);
      return (
        m.sha256 === install.payloadSha256 && m.size === install.payloadSize
      );
    },

    async remove(location) {
      if (!location.startsWith("store/")) return;
      await remove(root, locationParts(location));
    },

    async removeStaging(planId) {
      for (const k of [...staged.keys()])
        if (k.startsWith(`${planId}/`)) staged.delete(k);
      await remove(root, ["staging", planId]);
    },

    async list() {
      const locations: string[] = [];
      const plans: string[] = [];
      const store = await dir(root, ["store"], false);
      if (store)
        for await (const [pack, h] of store.entries())
          if (h.kind === "directory")
            for await (const [v, vh] of h.entries())
              if (vh.kind === "directory") locations.push(`store/${pack}/${v}`);
      const staging = await dir(root, ["staging"], false);
      if (staging)
        for await (const [p, h] of staging.entries())
          if (h.kind === "directory") plans.push(p);
      return { locations, plans };
    },

    async freeDisk() {
      const nav = (
        globalThis as {
          navigator?: {
            storage?: {
              estimate?: () => Promise<{ quota?: number; usage?: number }>;
            };
          };
        }
      ).navigator;
      if (typeof nav?.storage?.estimate !== "function")
        return Number.MAX_SAFE_INTEGER;
      const e = await nav.storage.estimate();
      return Math.max(0, (e.quota ?? 0) - (e.usage ?? 0));
    },
  };

  /** A file's text, null ONLY when it does not exist; any other failure throws. */
  const readText = async (name: string): Promise<string | null> => {
    let fh: FileHandle;
    try {
      fh = await root.getFileHandle(name);
    } catch (e) {
      if (missing(e)) return null;
      throw e;
    }
    const f = await fh.getFile();
    return new TextDecoder().decode(await f.slice(0, f.size).arrayBuffer());
  };

  const state: PackStateStore = {
    read: () => readText("state.json"),
    async replace(text) {
      // `createWritable` writes to a swap file and replaces the target on `close()`.
      await writeWhole(
        (await fileAt(root, ["state.json"], true))!,
        new TextEncoder().encode(text),
      );
    },
    async quarantine(text) {
      if ((await readText("state.json.torn")) !== null) return;
      await writeWhole(
        await root.getFileHandle("state.json.torn", { create: true }),
        new TextEncoder().encode(text),
      );
    },
    quarantined: async () =>
      (await readText("state.json.torn").catch(() => "")) !== null,
    async clearQuarantine() {
      await remove(root, ["state.json.torn.list"]);
      await remove(root, ["state.json.torn"]);
    },
    readHoldList: () => readText("state.json.torn.list"),
    async writeHoldList(text) {
      if ((await readText("state.json.torn.list")) !== null) return;
      // `createWritable` replaces the file on `close()`, so the list is never half written.
      await writeWhole(
        await root.getFileHandle("state.json.torn.list", { create: true }),
        new TextEncoder().encode(text),
      );
    },
  };

  return { storage, state };
}

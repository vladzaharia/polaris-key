// Byte I/O for the OPFS pack store (P4-18; notes/A7 §9.2). Two implementations of one small
// interface:
//
//   the main thread  `createWritable` and `getFile` (P4-06's original path): every browser that has
//                    OPFS, and the only one a test double or a host-supplied root can use;
//   a worker         a dedicated module worker (`opfsWorker.ts`) holding `FileSystemSyncAccessHandle`s,
//                    which write at 93-131 MB/s and read at 518-536 MB/s in Chromium (A7 §9.2), and
//                    which also fetches a payload URL straight into the plan's output
//                    (`fetchInto`), hashing as it writes, so the decoded payload never crosses to
//                    the page.
//
// A sync access handle locks its file, so the store releases a worker's handles under a path
// (`release`) before the main thread reads, copies or removes anything there.

import type { Sha256Port } from "@polaris-key/client-core";

/** A path below the store's root, by segments. */
export type OpfsPath = readonly string[];

/** What `fetchInto` reports. `status` is the HTTP status; on `200`, `size` and `sha256` are
 *  measured over exactly the bytes written (decoded, after any `Content-Encoding`). */
export type FetchIntoResult =
  | { status: number; size?: undefined; sha256?: undefined; error?: string }
  | { status: 200; size: number; sha256: string; error?: undefined };

export interface OpfsIo {
  /** `worker` or `main`. */
  readonly kind: "worker" | "main";
  writeAt(path: OpfsPath, offset: number, bytes: Uint8Array): Promise<void>;
  read(path: OpfsPath, offset: number, length: number): Promise<Uint8Array>;
  /** The file's size, or null when it does not exist. */
  size(path: OpfsPath): Promise<number | null>;
  /** Close every handle under `prefix` (a no-op on the main thread). */
  release(prefix: OpfsPath): Promise<void>;
  /** The file's size and SHA-256. */
  hash(path: OpfsPath): Promise<{ size: number; sha256: string }>;
  /**
   * Worker only: `GET url` (credentials included) and write the decoded body to `path` from
   * offset 0, refusing more than `limit` bytes. Anything but a `200` writes nothing.
   */
  fetchInto?(
    path: OpfsPath,
    url: string,
    init: { headers: Record<string, string> },
    limit: number,
    onBytes: (n: number) => void,
  ): Promise<FetchIntoResult>;
  /** Stop the worker (the main thread has nothing to stop). */
  close(): void;
}

// ── The main thread ─────────────────────────────────────────────────────────────────────────

/** The slice of the directory API the main-thread I/O uses (`opfs.ts` `DirHandle`). */
interface Dir {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<Dir>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<File_>;
}
interface File_ {
  getFile(): Promise<{
    size: number;
    slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
  }>;
  createWritable(opts?: { keepExistingData?: boolean }): Promise<{
    write(data: {
      type: "write";
      position: number;
      data: Uint8Array;
    }): Promise<void>;
    close(): Promise<void>;
  }>;
}

const CHUNK = 1 << 20;

function isMissing(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  return name === "NotFoundError" || name === "TypeMismatchError";
}

async function fileOf(
  root: Dir,
  path: OpfsPath,
  create: boolean,
): Promise<File_ | null> {
  let d = root;
  try {
    for (const p of path.slice(0, -1))
      d = await d.getDirectoryHandle(p, { create });
    return await d.getFileHandle(path[path.length - 1]!, { create });
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** P4-06's main-thread path, over `root` (a real OPFS directory or a test double). */
export function mainThreadIo(root: Dir, sha256: Sha256Port): OpfsIo {
  return {
    kind: "main",
    async writeAt(path, offset, bytes) {
      const fh = (await fileOf(root, path, true))!;
      const w = await fh.createWritable({ keepExistingData: true });
      await w.write({ type: "write", position: offset, data: bytes });
      await w.close();
    },
    async read(path, offset, length) {
      const fh = await fileOf(root, path, false);
      if (!fh) return new Uint8Array();
      const f = await fh.getFile();
      const end = Math.min(f.size, offset + length);
      if (end <= offset) return new Uint8Array();
      return new Uint8Array(await f.slice(offset, end).arrayBuffer());
    },
    async size(path) {
      const fh = await fileOf(root, path, false);
      return fh ? (await fh.getFile()).size : null;
    },
    release: async () => undefined,
    async hash(path) {
      const fh = await fileOf(root, path, false);
      if (!fh) throw new Error(`no file ${path.join("/")}`);
      const f = await fh.getFile();
      const h = sha256();
      for (let at = 0; at < f.size; at += CHUNK)
        h.update(
          new Uint8Array(
            await f.slice(at, Math.min(f.size, at + CHUNK)).arrayBuffer(),
          ),
        );
      return { size: f.size, sha256: await h.digest() };
    },
    close: () => undefined,
  };
}

// ── The worker ──────────────────────────────────────────────────────────────────────────────

/** One request to `opfsWorker.ts`. */
export type WorkerRequest =
  | { id: number; op: "init"; root: string[] }
  | {
      id: number;
      op: "writeAt";
      path: string[];
      offset: number;
      bytes: Uint8Array;
    }
  | { id: number; op: "read"; path: string[]; offset: number; length: number }
  | { id: number; op: "size"; path: string[] }
  | { id: number; op: "release"; prefix: string[] }
  | { id: number; op: "hash"; path: string[] }
  | {
      id: number;
      op: "fetchInto";
      path: string[];
      url: string;
      headers: Record<string, string>;
      limit: number;
    };

/** A request before the client numbers it. */
type WithoutId<T> = T extends unknown ? Omit<T, "id"> : never;

/** One answer from `opfsWorker.ts`: the result, a failure, or (for `fetchInto`) progress. */
export type WorkerResponse =
  | { id: number; ok: true; value: unknown }
  | { id: number; ok: false; error: string; name?: string }
  | { id: number; progress: number };

/** The slice of `Worker` the client uses (so a test can drive a fake). */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(
    type: "message" | "error",
    listener: (e: MessageEvent | ErrorEvent) => void,
  ): void;
  terminate(): void;
}

/** A failure the worker reported, keeping the DOMException's name (`NotFoundError`, …). */
class WorkerIoError extends Error {
  constructor(
    message: string,
    readonly domName: string | undefined,
  ) {
    super(message);
    this.name = domName ?? "Error";
  }
}

/**
 * The worker client: `root` is the store's path below `navigator.storage.getDirectory()`. Resolves
 * once the worker has opened it, and rejects (the caller then keeps the main thread) when the
 * worker cannot start, cannot reach OPFS or cannot create a sync access handle within `timeoutMs`.
 */
export async function workerIo(
  worker: WorkerLike,
  root: readonly string[],
  timeoutMs = 5000,
): Promise<OpfsIo> {
  let next = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      onProgress?: (n: number) => void;
    }
  >();
  let dead: Error | null = null;
  const fail = (e: Error) => {
    dead ??= e;
    for (const p of pending.values()) p.reject(e);
    pending.clear();
  };
  worker.addEventListener("message", (ev) => {
    const m = (ev as MessageEvent).data as WorkerResponse;
    const p = pending.get(m.id);
    if (!p) return;
    if ("progress" in m) {
      p.onProgress?.(m.progress);
      return;
    }
    pending.delete(m.id);
    if (m.ok) p.resolve(m.value);
    else p.reject(new WorkerIoError(m.error, m.name));
  });
  worker.addEventListener("error", (ev) =>
    fail(new Error(`OPFS worker failed: ${(ev as ErrorEvent).message ?? ""}`)),
  );
  const call = <T>(
    req: WithoutId<WorkerRequest>,
    transfer: Transferable[] = [],
    onProgress?: (n: number) => void,
  ): Promise<T> => {
    if (dead) return Promise.reject(dead);
    const id = next++;
    return new Promise<T>((resolve, reject) => {
      pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      worker.postMessage({ ...req, id }, transfer);
    });
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      call({ op: "init", root: [...root] }),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("OPFS worker did not start")),
          timeoutMs,
        );
      }),
    ]);
  } catch (e) {
    worker.terminate();
    throw e;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  return {
    kind: "worker",
    async writeAt(path, offset, bytes) {
      // A copy the worker owns (the caller may reuse its buffer).
      const copy = bytes.slice();
      await call({ op: "writeAt", path: [...path], offset, bytes: copy }, [
        copy.buffer,
      ]);
    },
    read: (path, offset, length) =>
      call<Uint8Array>({ op: "read", path: [...path], offset, length }),
    size: (path) => call<number | null>({ op: "size", path: [...path] }),
    async release(prefix) {
      await call({ op: "release", prefix: [...prefix] });
    },
    hash: (path) =>
      call<{ size: number; sha256: string }>({ op: "hash", path: [...path] }),
    fetchInto: (path, url, init, limit, onBytes) =>
      call<FetchIntoResult>(
        {
          op: "fetchInto",
          path: [...path],
          url,
          headers: init.headers,
          limit,
        },
        [],
        onBytes,
      ),
    close() {
      fail(new Error("OPFS worker closed"));
      worker.terminate();
    },
  };
}

/**
 * Start the store's worker (`opfsWorker.ts`, a module worker beside this file), or null where
 * there is none to start: no `Worker`, or no `createSyncAccessHandle` on file handles.
 */
export async function startOpfsWorker(
  root: readonly string[],
  spawn?: () => WorkerLike,
): Promise<OpfsIo | null> {
  const g = globalThis as {
    Worker?: unknown;
    FileSystemFileHandle?: { prototype: object };
  };
  if (!spawn) {
    if (typeof g.Worker !== "function") return null;
    if (
      !g.FileSystemFileHandle ||
      !("createSyncAccessHandle" in g.FileSystemFileHandle.prototype)
    )
      return null;
  }
  let worker: WorkerLike;
  try {
    // Written out literally: bundlers (Vite, webpack, Rollup, esbuild plugins) recognise exactly
    // `new Worker(new URL("…", import.meta.url))` and emit the worker beside the page's bundle.
    worker = spawn
      ? spawn()
      : (new Worker(new URL("./opfsWorker.js", import.meta.url), {
          type: "module",
        }) as unknown as WorkerLike);
  } catch {
    return null;
  }
  try {
    return await workerIo(worker, root);
  } catch {
    return null;
  }
}

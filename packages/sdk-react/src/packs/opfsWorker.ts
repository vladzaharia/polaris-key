// The OPFS pack store's dedicated worker (P4-18; notes/A7 §9.2; the client is `opfsIo.ts`
// `workerIo`). It holds `FileSystemSyncAccessHandle`s, which only a dedicated worker may create,
// for the store's staging files, and it fetches a payload URL straight into a plan's output,
// hashing (hash-wasm, streaming) as it writes, so a decoded payload never crosses to the page.
//
// A sync access handle locks its file: the client asks for `release` of a path prefix before the
// page reads, copies or removes anything there. Every request answers exactly once; a `fetchInto`
// also posts progress (decoded bytes written so far).

import { createSHA256 } from "hash-wasm";
import type { WorkerRequest, WorkerResponse } from "./opfsIo.js";

/** The slice of `FileSystemSyncAccessHandle` this worker uses. */
interface SyncHandle {
  read(buffer: Uint8Array, opts: { at: number }): number;
  write(buffer: Uint8Array, opts: { at: number }): number;
  getSize(): number;
  truncate(size: number): void;
  flush(): void;
  close(): void;
}
interface FileH {
  createSyncAccessHandle(): Promise<SyncHandle>;
}
interface DirH {
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<DirH>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FileH>;
}

const scope = globalThis as unknown as {
  navigator: { storage: { getDirectory(): Promise<DirH> } };
  postMessage(m: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(
    type: "message",
    listener: (e: { data: WorkerRequest }) => void,
  ): void;
};

const CHUNK = 1 << 20;
let root: DirH | null = null;
const handles = new Map<string, SyncHandle>();
const keyOf = (path: readonly string[]) => path.join("/");

function missing(e: unknown): boolean {
  const name = (e as { name?: string }).name;
  return name === "NotFoundError" || name === "TypeMismatchError";
}

async function fileOf(
  path: readonly string[],
  create: boolean,
): Promise<FileH | null> {
  if (!root) throw new Error("OPFS worker not initialised");
  let d = root;
  try {
    for (const p of path.slice(0, -1))
      d = await d.getDirectoryHandle(p, { create });
    return await d.getFileHandle(path[path.length - 1]!, { create });
  } catch (e) {
    if (missing(e)) return null;
    throw e;
  }
}

/** The open handle for `path` (opened, and created when `create`), or null when it is absent. */
async function handle(
  path: readonly string[],
  create: boolean,
): Promise<SyncHandle | null> {
  const key = keyOf(path);
  const open = handles.get(key);
  if (open) return open;
  const fh = await fileOf(path, create);
  if (!fh) return null;
  const h = await fh.createSyncAccessHandle();
  handles.set(key, h);
  return h;
}

function releaseUnder(prefix: readonly string[]): void {
  const p = keyOf(prefix);
  for (const [key, h] of [...handles]) {
    if (key === p || key.startsWith(`${p}/`)) {
      try {
        h.flush();
      } catch {
        // Closing is what matters.
      }
      h.close();
      handles.delete(key);
    }
  }
}

function writeAll(h: SyncHandle, bytes: Uint8Array, at: number): void {
  let done = 0;
  while (done < bytes.byteLength) {
    const n = h.write(bytes.subarray(done), { at: at + done });
    if (n <= 0) throw new Error("OPFS write wrote nothing");
    done += n;
  }
}

async function run(
  req: WorkerRequest,
): Promise<{ value: unknown; transfer?: Transferable[] }> {
  switch (req.op) {
    case "init": {
      let d = await scope.navigator.storage.getDirectory();
      for (const p of req.root)
        d = await d.getDirectoryHandle(p, { create: true });
      root = d;
      // Prove a sync access handle can be created here, then let it go.
      const probe = await handle([".pkey-worker-probe"], true);
      probe!.close();
      handles.delete(".pkey-worker-probe");
      return { value: true };
    }
    case "writeAt": {
      const h = (await handle(req.path, true))!;
      writeAll(h, req.bytes, req.offset);
      return { value: null };
    }
    case "read": {
      const h = await handle(req.path, false);
      if (!h) return { value: new Uint8Array() };
      const size = h.getSize();
      const n = Math.max(0, Math.min(req.length, size - req.offset));
      const buf = new Uint8Array(n);
      let got = 0;
      while (got < n) {
        const r = h.read(buf.subarray(got), { at: req.offset + got });
        if (r <= 0) break;
        got += r;
      }
      const out = got === n ? buf : buf.slice(0, got);
      return { value: out, transfer: [out.buffer] };
    }
    case "size": {
      const h = await handle(req.path, false);
      return { value: h ? h.getSize() : null };
    }
    case "release":
      releaseUnder(req.prefix);
      return { value: null };
    case "hash": {
      const h = await handle(req.path, false);
      if (!h) {
        const e = new Error(`no file ${req.path.join("/")}`);
        e.name = "NotFoundError";
        throw e;
      }
      const hasher = await createSHA256();
      hasher.init();
      const size = h.getSize();
      const buf = new Uint8Array(CHUNK);
      for (let at = 0; at < size; ) {
        const r = h.read(buf.subarray(0, Math.min(CHUNK, size - at)), { at });
        if (r <= 0) break;
        hasher.update(buf.subarray(0, r));
        at += r;
      }
      releaseUnder(req.path);
      return { value: { size, sha256: hasher.digest("hex") } };
    }
    case "fetchInto": {
      const res = await fetch(req.url, {
        credentials: "include",
        headers: req.headers,
      });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { value: { status: res.status } };
      }
      const h = (await handle(req.path, true))!;
      h.truncate(0);
      const hasher = await createSHA256();
      hasher.init();
      let at = 0;
      let lastPost = 0;
      const reader = res.body!.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (at + value.byteLength > req.limit) {
            await reader.cancel().catch(() => undefined);
            h.truncate(0);
            return { value: { status: 200, error: "too-large" } };
          }
          writeAll(h, value, at);
          hasher.update(value);
          at += value.byteLength;
          if (at - lastPost >= CHUNK) {
            lastPost = at;
            scope.postMessage({ id: req.id, progress: at });
          }
        }
      } catch (e) {
        // A transfer that fails part way (a network error, a body the browser cannot decode).
        h.truncate(0);
        return {
          value: {
            status: 200,
            error: `network-error: ${(e as Error).message ?? e}`,
          },
        };
      }
      h.flush();
      scope.postMessage({ id: req.id, progress: at });
      return {
        value: { status: 200, size: at, sha256: hasher.digest("hex") },
      };
    }
  }
}

// One request at a time, in order: the client awaits every write before the next, and a fetch
// must not interleave with a write to the same handle.
let queue: Promise<void> = Promise.resolve();
scope.addEventListener("message", (e) => {
  const req = e.data;
  queue = queue.then(async () => {
    try {
      const { value, transfer } = await run(req);
      scope.postMessage({ id: req.id, ok: true, value }, transfer ?? []);
    } catch (err) {
      scope.postMessage({
        id: req.id,
        ok: false,
        error: (err as Error).message ?? String(err),
        name: (err as { name?: string }).name,
      });
    }
  });
});

// The Node pack store (P4-06; CONTENT §9–§10): staging, the content-addressed store and the
// install-state file under one directory, by default `<data dir>/packs` (P1b-09's platform data
// directory, excluded from backups).
//
//   <root>/state.json                         the install state, written by temp + rename
//   <root>/staging/<planId>/objects/<sha256>  objects being fetched (appended, resumable)
//   <root>/staging/<planId>/out/              the payload being built (a tree's files, or
//                                             `payload.bin` for a container)
//   <root>/store/<packId>/<payloadSha256>/    a committed payload, never overwritten: a tree's
//                                             files, or `payload.bin`; `.pkey/files.json` beside
//                                             them holds the files index kept at install
//
// A `files.tree` pack is hot: the versioned directory is complete before the state's pointer
// swaps to it, and nothing in it is ever rewritten. `.pkey/` cannot collide with a pack file:
// the path rules refuse a first segment `.pkey` (plans/P4-01.md §2.7).

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  appendFile,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  type StagedObject,
  type TreeSink,
} from "@polaris-key/client-core";

const CONTAINER_FILE = "payload.bin";
const INDEX_FILE = join(".pkey", "files.json");

/** A file on disk as a `ByteSource`. */
export function fileSource(path: string, size: number): ByteSource {
  return {
    size,
    async read(offset, length) {
      const n = Math.max(0, Math.min(length, size - offset));
      if (n === 0) return new Uint8Array();
      const fh = await open(path, "r");
      try {
        const buf = new Uint8Array(n);
        const { bytesRead } = await fh.read(buf, 0, n, offset);
        return buf.subarray(0, bytesRead);
      } finally {
        await fh.close();
      }
    },
  };
}

/** A directory's entries, or none ONLY when it does not exist (ENOENT, ENOTDIR). */
async function readdirOrEmpty(
  dir: string,
): Promise<import("node:fs").Dirent[]> {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
}

function isMissing(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Whether `path` exists: false ONLY for ENOENT and ENOTDIR. Anything else (EACCES, EIO)
 *  throws, so "cannot read" is never mistaken for "missing" (`verify`, `installed`,
 *  `quarantined` and `commit` all rely on that). */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw e;
  }
}

/** Every file under `dir`, as `/`-separated paths relative to it, skipping `.pkey/`. */
export async function walkTree(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(at: string): Promise<void> {
    for (const e of await readdir(at, { withFileTypes: true })) {
      const p = join(at, e.name);
      const rel = relative(dir, p).split(sep).join("/");
      if (rel === ".pkey" || rel.startsWith(".pkey/")) continue;
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(rel);
      // Symlinks and other entries are never part of a tree payload.
    }
  }
  await walk(dir);
  return out;
}

async function hashFile(path: string): Promise<string> {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** A directory's files with their sizes and SHA-256 (the embedded and reload checks). */
export async function measureTree(
  dir: string,
): Promise<{ path: string; size: number; sha256: string }[]> {
  const files = [];
  for (const path of await walkTree(dir)) {
    const abs = join(dir, ...path.split("/"));
    files.push({
      path,
      size: (await stat(abs)).size,
      sha256: await hashFile(abs),
    });
  }
  return files;
}

/** `treeDigest` of a directory, minus `.pkey/` (plans/P4-01.md §2.6). */
export async function directoryTreeDigest(dir: string): Promise<string> {
  return treeDigest(await measureTree(dir));
}

/** A single file's SHA-256 and size. */
export async function measureFile(
  path: string,
): Promise<{ sha256: string; size: number }> {
  return { sha256: await hashFile(path), size: (await stat(path)).size };
}

/** A container install's payload file: `payload.bin` in the store, or the embedded file itself
 *  (an embedded single-file baseline's location is the file). */
function payloadFile(install: PackInstall): string {
  return install.embedded === true
    ? install.location
    : join(install.location, CONTAINER_FILE);
}

/** The errors a file system answers when it cannot sync a directory at all. */
const DIR_SYNC_UNSUPPORTED = new Set(["EISDIR", "EPERM", "EBADF", "EINVAL"]);

/**
 * fsync a directory, so a rename or a new entry in it survives a power loss. Windows cannot open
 * a directory for syncing; there it is a no-op. On macOS Node's `fsync` is `fsync(2)`, which
 * reaches the drive but not through its write cache (`F_FULLFSYNC`, which Node does not expose),
 * so a power loss there can still lose the last writes; the rename stays atomic either way.
 */
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return; // Windows cannot open a directory for syncing.
  let fh;
  try {
    fh = await open(dir, "r");
  } catch (e) {
    if (DIR_SYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? ""))
      return;
    throw e;
  }
  try {
    await fh.sync();
  } catch (e) {
    // A file system that cannot sync a directory says so with one of these; EIO and the like
    // mean the data may not be on disk, and are raised.
    if (!DIR_SYNC_UNSUPPORTED.has((e as NodeJS.ErrnoException).code ?? ""))
      throw e;
  } finally {
    await fh.close();
  }
}

/** fsync every file under `dir`, then each directory, depth first. */
async function syncTree(dir: string): Promise<void> {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await syncTree(p);
    else if (e.isFile()) {
      const fh = await open(p, "r+");
      try {
        await fh.sync();
      } finally {
        await fh.close();
      }
    }
  }
  await syncDir(dir);
}

/** `path` joined under `root`, refusing anything that would land outside it. */
function inside(root: string, ...parts: string[]): string {
  const p = resolve(root, ...parts);
  if (p !== root && !p.startsWith(root + sep))
    throw new Error(`pack path escapes its root: ${parts.join("/")}`);
  return p;
}

export interface DirPackStorageOptions {
  /** The root directory (created on first use). */
  root: string;
}

/** The `PackStorage` and `PackStateStore` over a directory. */
export class DirPackStorage implements PackStorage {
  readonly root: string;
  readonly stagingDir: string;
  readonly storeDir: string;
  /** Measured trees of embedded locations (verified once per process). */
  private readonly embeddedFiles = new Map<string, InstalledFile[]>();

  constructor(opts: DirPackStorageOptions) {
    this.root = resolve(opts.root);
    this.stagingDir = join(this.root, "staging");
    this.storeDir = join(this.root, "store");
  }

  /** The atomic-replace state file. */
  /** The atomic-replace state file, with a torn document's quarantine at `state.json.torn`. */
  stateStore(): PackStateStore {
    const path = join(this.root, "state.json");
    const torn = `${path}.torn`;
    const holdList = `${path}.torn.list`;
    return {
      read: async () => {
        try {
          return await readFile(path, "utf8");
        } catch (e) {
          // Only a missing file is "no state"; anything else is unknown, never empty.
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw e;
        }
      },
      replace: async (text) => {
        await mkdir(this.root, { recursive: true });
        const tmp = `${path}.${process.pid}.tmp`;
        const fh = await open(tmp, "w", 0o600);
        try {
          await fh.writeFile(text);
          // Durable before the rename, so a power loss never leaves a torn state file.
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, path);
        await syncDir(this.root);
      },
      quarantine: async (text) => {
        if (await exists(torn)) return;
        const fh = await open(torn, "wx", 0o600);
        try {
          await fh.writeFile(text);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await syncDir(this.root);
      },
      quarantined: async () => exists(torn),
      clearQuarantine: async () => {
        await rm(holdList, { force: true });
        await rm(torn, { force: true });
      },
      readHoldList: async () => {
        try {
          return await readFile(holdList, "utf8");
        } catch (e) {
          if (isMissing(e)) return null;
          throw e;
        }
      },
      writeHoldList: async (text) => {
        if (await exists(holdList)) return;
        const tmp = `${holdList}.${process.pid}.tmp`;
        const fh = await open(tmp, "w", 0o600);
        try {
          await fh.writeFile(text);
          await fh.sync();
        } finally {
          await fh.close();
        }
        await rename(tmp, holdList);
        await syncDir(this.root);
      },
    };
  }

  private objectPath(planId: string, sha256: string): string {
    return inside(this.stagingDir, planId, "objects", sha256);
  }

  async stagedObject(planId: string, sha256: string): Promise<StagedObject> {
    const path = this.objectPath(planId, sha256);
    const size = async () => {
      try {
        return (await stat(path)).size;
      } catch (e) {
        if (!isMissing(e)) throw e;
        return 0;
      }
    };
    return {
      size,
      source: async () => fileSource(path, await size()),
      append: async (bytes) => {
        await mkdir(dirname(path), { recursive: true });
        await appendFile(path, bytes);
      },
      reset: async () => {
        await rm(path, { force: true });
      },
    };
  }

  async output(
    planId: string,
    layout: string,
  ): Promise<{ sink?: ByteSink; tree?: TreeSink }> {
    const out = inside(this.stagingDir, planId, "out");
    await rm(out, { recursive: true, force: true });
    await mkdir(out, { recursive: true });
    if (layout === "tree")
      return {
        tree: {
          writeFile: async (path, bytes) => {
            const abs = inside(out, ...path.split("/"));
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, bytes);
          },
        },
      };
    const file = join(out, CONTAINER_FILE);
    await writeFile(file, new Uint8Array());
    return {
      sink: {
        write: async (offset, bytes) => {
          const fh = await open(file, "r+");
          try {
            await fh.write(bytes, 0, bytes.byteLength, offset);
          } finally {
            await fh.close();
          }
        },
      },
    };
  }

  async commit(
    planId: string,
    packId: string,
    payloadSha256: string,
    _layout: string,
    index: FilesIndexDoc | null,
  ): Promise<string> {
    const out = inside(this.stagingDir, planId, "out");
    const location = inside(this.storeDir, packId, payloadSha256);
    if (index !== null) {
      await mkdir(join(out, ".pkey"), { recursive: true });
      await writeFile(join(out, INDEX_FILE), JSON.stringify(index));
    }
    if (await exists(location)) {
      // The same payload is already stored (a rollback target, say): keep the stored copy.
      await rm(out, { recursive: true, force: true });
      return location;
    }
    // The payload is durable before the pointer can name it.
    await syncTree(out);
    await mkdir(dirname(location), { recursive: true });
    await rename(out, location);
    await syncDir(dirname(location));
    return location;
  }

  async installed(install: PackInstall): Promise<InstalledPayload | null> {
    const loc = install.location;
    if (!(await exists(loc))) return null;
    if (install.layout === "tree") {
      const files = await this.treeFiles(loc, install.embedded === true);
      return files === null ? null : { payload: null, files };
    }
    const file = payloadFile(install);
    if (!(await exists(file))) return null;
    const whole = fileSource(file, (await stat(file)).size);
    const index = await this.readIndex(loc);
    return {
      payload: whole,
      files:
        index?.files.map((f) => ({
          path: f.path,
          sha256: f.sha256,
          size: f.size,
          source: {
            size: f.size,
            read: (at, n) =>
              whole.read(
                (f.offset ?? 0) + at,
                Math.max(0, Math.min(n, f.size - at)),
              ),
          },
        })) ?? null,
    };
  }

  private async readIndex(location: string): Promise<FilesIndexDoc | null> {
    try {
      return JSON.parse(
        await readFile(join(location, INDEX_FILE), "utf8"),
      ) as FilesIndexDoc;
    } catch (e) {
      // Missing or not JSON: no kept index. Unreadable: thrown (the caller does not use it).
      if ((e as NodeJS.ErrnoException).code !== undefined && !isMissing(e))
        throw e;
      return null;
    }
  }

  /** A tree's files: from the index kept at install, else (an embedded tree) measured once. */
  private async treeFiles(
    location: string,
    embedded: boolean,
  ): Promise<InstalledFile[] | null> {
    const index = embedded ? null : await this.readIndex(location);
    let entries: { path: string; size: number; sha256: string }[];
    if (index !== null) entries = index.files;
    else {
      const cached = this.embeddedFiles.get(location);
      if (cached) return cached;
      entries = await measureTree(location);
    }
    const files = entries.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      size: f.size,
      source: fileSource(join(location, ...f.path.split("/")), f.size),
    }));
    if (index === null) this.embeddedFiles.set(location, files);
    return files;
  }

  /** False when the payload is missing or its digest differs; throws when it cannot be read
   *  (the engine then neither uses nor collects it this load). */
  async verify(install: PackInstall): Promise<boolean> {
    if (install.layout === "tree") {
      if (!(await exists(install.location))) return false;
      return (
        (await directoryTreeDigest(install.location)) === install.payloadSha256
      );
    }
    const file = payloadFile(install);
    if (!(await exists(file))) return false;
    const m = await measureFile(file);
    return m.sha256 === install.payloadSha256 && m.size === install.payloadSize;
  }

  async remove(location: string): Promise<void> {
    // Only ever inside the store: an embedded payload lives in the app's resources.
    const abs = resolve(location);
    if (!abs.startsWith(this.storeDir + sep)) return;
    await rm(abs, { recursive: true, force: true });
  }

  async removeStaging(planId: string): Promise<void> {
    await rm(inside(this.stagingDir, planId), { recursive: true, force: true });
  }

  async list(): Promise<{ locations: string[]; plans: string[] }> {
    const locations: string[] = [];
    const plans: string[] = [];
    // Only a missing directory is "nothing there"; an unreadable one throws, so the engine never
    // plans garbage collection from a partial listing.
    for (const pack of await readdirOrEmpty(this.storeDir))
      if (pack.isDirectory())
        for (const v of await readdirOrEmpty(join(this.storeDir, pack.name)))
          if (v.isDirectory())
            locations.push(join(this.storeDir, pack.name, v.name));
    for (const p of await readdirOrEmpty(this.stagingDir))
      if (p.isDirectory()) plans.push(p.name);
    return { locations, plans };
  }

  async freeDisk(): Promise<number> {
    await mkdir(this.root, { recursive: true });
    const s = await statfs(this.root);
    return Number(s.bavail) * Number(s.bsize);
  }
}

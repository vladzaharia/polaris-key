// The receiver's partial files for Direct Transfer (CC-20.3; WIRE-CONTRACT-V5 §15.11, "Resume" and
// "The name is display data"). One directory per product under the SDK's state directory:
//
//   <state>/transfer/        0700, owned by this user (a link, a foreign owner or a loose mode is refused)
//     p/<ref>.part           the bytes received so far          0600
//     p/<ref>.meta           {v, peer, id, sha256, size, chunk}  0600
//     spool/<random>         a one-pass stream the sender spooled so as to hash it  0600
//
// Rules this module keeps:
//  - a file is named by `ref` only: the 64 hex characters client-core derives from the peer key, the
//    transfer id and the hash. The peer's `name` never reaches a path here, and a `ref` that is not
//    64 lowercase hex characters is refused before any path is built;
//  - files are made with `O_EXCL | O_NOFOLLOW` and opened with `O_NOFOLLOW`;
//  - a partial older than 24 h from its last write, and the oldest ones past `MAX_FILES`, are
//    removed; the bytes held are bounded by `quotaBytes` and by the free space of the volume, both
//    answered synchronously to the machine from a cache that every write keeps current;
//  - content leaves only through `deliver`, once the machine says the hash matched, into a place the
//    host named: written beside it under a random name, synced, then moved with `rename` (or
//    `link`, which refuses an existing file) so a reader never sees a half-written file.

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  openSync,
  readSync,
  createReadStream,
} from "node:fs";
import {
  copyFile,
  link,
  lstat,
  mkdir,
  chmod,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  unlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  XFER_PARTIAL_SECONDS,
  XferHasher,
  type XferPartial,
} from "@polaris-key/client-core/peer";

const isWindows = process.platform === "win32";
const NOFOLLOW = fsc.O_NOFOLLOW ?? 0;
const REF = /^[0-9a-f]{64}$/;
const HEX = (b: Uint8Array): string => Buffer.from(b).toString("hex");

/** The most partial files held for all peers together. */
export const TRANSFER_MAX_FILES = 64;
/** The bytes all partial files may take together. */
export const TRANSFER_QUOTA_BYTES = 4 * 1024 ** 3;
/** Space left on the volume that partial files never use. */
export const DISK_RESERVE = 256 * 1024 ** 2;

/** What `p/<ref>.meta` holds: the resume key's parts, nothing the peer chose but the id and hash. */
interface Meta {
  v: 1;
  peer: string;
  id: string;
  sha256: string;
  size: number;
  chunk: number;
}

export interface StoreOptions {
  /** Milliseconds since the epoch. */
  now?: () => number;
  quotaBytes?: number;
  maxFiles?: number;
}

/** Where a delivered transfer goes: a file the host named, or a reader for a stream. */
export type DeliverTo =
  | { saveTo: string; overwrite: boolean }
  | { stream: (data: AsyncIterable<Uint8Array>) => Promise<void> };

export class TransferStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransferStoreError";
  }
}

export class PartialStore {
  readonly #root: string;
  readonly #now: () => number;
  #quota: number;
  readonly #maxFiles: number;
  #ready: Promise<void> | null = null;
  readonly #handles = new Map<string, FileHandle>();
  /** Every `.part` on disk and its size, kept current by the writes. */
  readonly #sizes = new Map<string, number>();
  #disk: number | null = null;
  /** Bytes promised to accepted transfers: token -> size, and the partial each one writes. */
  readonly #reserved = new Map<string, { size: number; ref: string | null }>();
  #sweeper: NodeJS.Timeout | null = null;
  #gen = 0;

  constructor(root: string, o: StoreOptions = {}) {
    this.#root = resolve(root);
    this.#now = o.now ?? Date.now;
    this.#quota = o.quotaBytes ?? TRANSFER_QUOTA_BYTES;
    this.#maxFiles = o.maxFiles ?? TRANSFER_MAX_FILES;
  }

  /** Bumped by `purgeAll`: an effect begun under an older generation must not touch the store. */
  get generation(): number {
    return this.#gen;
  }

  /** Change the byte bound (tests, hosts with a smaller disk budget). */
  setQuota(bytes: number): void {
    this.#quota = bytes;
  }

  get root(): string {
    return this.#root;
  }

  get #parts(): string {
    return join(this.#root, "p");
  }

  get spoolDir(): string {
    return join(this.#root, "spool");
  }

  #part = (ref: string): string => {
    if (!REF.test(ref)) throw new TransferStoreError("bad partial reference");
    return join(this.#parts, `${ref}.part`);
  };
  #meta = (ref: string): string => {
    if (!REF.test(ref)) throw new TransferStoreError("bad partial reference");
    return join(this.#parts, `${ref}.meta`);
  };

  /** Make the directories (owner only) and read what is on disk. Safe to call again. */
  ready(): Promise<void> {
    this.#ready ??= this.#init().catch((e: unknown) => {
      this.#ready = null;
      throw e;
    });
    return this.#ready;
  }

  async #private(dir: string): Promise<void> {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const st = await lstat(dir);
    if (!st.isDirectory() || st.isSymbolicLink())
      throw new TransferStoreError("the transfer directory is not a directory");
    if (!isWindows) {
      if (st.uid !== process.getuid?.())
        throw new TransferStoreError("the transfer directory is not ours");
      if ((st.mode & 0o077) !== 0) await chmod(dir, 0o700);
    }
  }

  async #init(): Promise<void> {
    await this.#private(this.#root);
    await this.#private(this.#parts);
    await this.#private(this.spoolDir);
    await this.#scan();
  }

  async #scan(): Promise<void> {
    this.#sizes.clear();
    const now = this.#now();
    for (const name of await readdir(this.#parts)) {
      const m = /^([0-9a-f]{64})\.(part|meta)$/.exec(name);
      if (m === null) {
        // Not ours: a stray name is removed, never read.
        await rm(join(this.#parts, name), { force: true, recursive: true });
        continue;
      }
      const ref = m[1]!;
      if (m[2] === "meta") {
        if (!(await exists(this.#part(ref)))) await this.#drop(ref);
        continue;
      }
      const st = await stat(this.#part(ref)).catch(() => null);
      if (
        st === null ||
        now - st.mtimeMs > XFER_PARTIAL_SECONDS * 1000 ||
        (await this.#readMeta(ref)) === null
      ) {
        await this.#drop(ref);
        continue;
      }
      this.#sizes.set(ref, st.size);
    }
    // Spooled streams belong to a process that is gone.
    for (const name of await readdir(this.spoolDir))
      await rm(join(this.spoolDir, name), { force: true, recursive: true });
    this.#disk = await statfs(this.#root)
      .then((s) => Number(s.bavail) * Number(s.bsize))
      .catch(() => null);
    while (this.#sizes.size > this.#maxFiles && (await this.#evictOldest()));
  }

  /**
   * Remove the oldest partial nobody holds (no open file, no reservation). False when every one is
   * held: the caller then refuses rather than take another transfer's file.
   */
  async #evictOldest(): Promise<boolean> {
    const bound = new Set(
      [...this.#reserved.values()].map((r) => r.ref).filter((r) => r !== null),
    );
    let oldest: { ref: string; at: number } | null = null;
    for (const ref of this.#sizes.keys()) {
      if (this.#handles.has(ref) || bound.has(ref)) continue;
      const st = await stat(this.#part(ref)).catch(() => null);
      const at = st?.mtimeMs ?? 0;
      if (oldest === null || at < oldest.at) oldest = { ref, at };
    }
    if (oldest === null) return false;
    await this.#drop(oldest.ref);
    return true;
  }

  /** Drop expired partials nobody holds and look at the volume again. Also runs hourly. */
  async sweep(): Promise<void> {
    if (this.#ready === null) return;
    await this.ready();
    const now = this.#now();
    for (const ref of [...this.#sizes.keys()]) {
      if (this.#handles.has(ref)) continue;
      const st = await stat(this.#part(ref)).catch(() => null);
      if (st === null || now - st.mtimeMs > XFER_PARTIAL_SECONDS * 1000)
        await this.#drop(ref);
    }
    this.#disk = await statfs(this.#root)
      .then((x) => Number(x.bavail) * Number(x.bsize))
      .catch(() => this.#disk);
  }

  /** Sweep every hour while the process runs (the timer does not keep it alive). */
  startSweeper(): void {
    if (this.#sweeper !== null) return;
    this.#sweeper = setInterval(
      () => void this.sweep().catch(() => undefined),
      3_600_000,
    );
    this.#sweeper.unref();
  }

  // ── reservations ───────────────────────────────────────────────────────────

  /**
   * Promise `size` bytes to an accepted transfer; `free()` counts it at once. The check and the
   * promise are one synchronous step: false (and nothing promised) when the promise no longer
   * fits, as when another accepted transfer took the room after this offer was shown. `ref` is
   * the kept partial this transfer resumes, whose bytes are inside the promise.
   */
  reserve(token: string, size: number, ref: string | null = null): boolean {
    this.#reserved.set(token, { size, ref });
    if (this.#headroom() >= 0) return true;
    this.#reserved.delete(token);
    return false;
  }

  /** The partial this transfer writes (its bytes are inside the reservation, not counted twice). */
  bind(token: string, ref: string): void {
    const r = this.#reserved.get(token);
    if (r !== undefined) r.ref = ref;
  }

  release(token: string): void {
    this.#reserved.delete(token);
  }

  async #readMeta(ref: string): Promise<Meta | null> {
    try {
      const v = JSON.parse(await readFile(this.#meta(ref), "utf8")) as Meta;
      return v.v === 1 &&
        typeof v.peer === "string" &&
        typeof v.id === "string" &&
        typeof v.sha256 === "string" &&
        Number.isSafeInteger(v.size) &&
        Number.isSafeInteger(v.chunk)
        ? v
        : null;
    } catch {
      return null;
    }
  }

  /** The kept partials of one peer key, ages in seconds since the last write. */
  async list(
    peerKey: Uint8Array,
  ): Promise<(Omit<XferPartial, "writtenAt" | "held"> & { age: number })[]> {
    await this.ready();
    const peer = HEX(peerKey);
    const out: (Omit<XferPartial, "writtenAt" | "held"> & {
      age: number;
    })[] = [];
    for (const ref of [...this.#sizes.keys()]) {
      const meta = await this.#readMeta(ref);
      if (meta === null || meta.peer !== peer) continue;
      const st = await stat(this.#part(ref)).catch(() => null);
      if (st === null) continue;
      if (
        this.#now() - st.mtimeMs > XFER_PARTIAL_SECONDS * 1000 &&
        !this.#handles.has(ref)
      ) {
        await this.#drop(ref);
        continue;
      }
      out.push({
        ref,
        id: meta.id,
        sha256: meta.sha256,
        size: meta.size,
        chunk: meta.chunk,
        bytes: st.size,
        age: Math.max(0, (this.#now() - st.mtimeMs) / 1000),
      });
    }
    return out;
  }

  /** The id and hash a kept partial was made for. */
  async metaOf(ref: string): Promise<{ id: string; sha256: string } | null> {
    const m = await this.#readMeta(ref);
    return m === null ? null : { id: m.id, sha256: m.sha256 };
  }

  /**
   * Bytes the store can still take, or null when unknown: the quota less the partials not bound to
   * an accepted transfer, less what every accepted transfer has been promised, and the volume's
   * free space less the reserve and what is promised but not yet written.
   */
  free(): number | null {
    return Math.max(0, this.#headroom());
  }

  /** What `free()` is made of, before it is clamped at 0: negative when the promises overrun. */
  #headroom(): number {
    const bound = new Set<string>();
    let promised = 0;
    let unwrittenPromise = 0;
    for (const r of this.#reserved.values()) {
      promised += r.size;
      if (r.ref !== null) bound.add(r.ref);
      unwrittenPromise += Math.max(
        0,
        r.size - (r.ref === null ? 0 : (this.#sizes.get(r.ref) ?? 0)),
      );
    }
    let used = 0;
    for (const [ref, n] of this.#sizes) if (!bound.has(ref)) used += n;
    const room = this.#quota - used - promised;
    if (this.#disk === null) return room;
    return Math.min(room, this.#disk - DISK_RESERVE - unwrittenPromise);
  }

  // ── effects ────────────────────────────────────────────────────────────────

  async create(
    ref: string,
    peerKey: Uint8Array,
    p: XferPartial,
  ): Promise<void> {
    await this.ready();
    while (this.#sizes.size >= this.#maxFiles)
      if (!(await this.#evictOldest()))
        throw new TransferStoreError("the store is full");
    await this.#drop(ref);
    const meta: Meta = {
      v: 1,
      peer: HEX(peerKey),
      id: p.id,
      sha256: p.sha256,
      size: p.size,
      chunk: p.chunk,
    };
    const fh = await open(
      this.#part(ref),
      fsc.O_RDWR | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW,
      0o600,
    );
    this.#handles.set(ref, fh);
    this.#sizes.set(ref, 0);
    await writeFile(this.#meta(ref), JSON.stringify(meta), {
      mode: 0o600,
      flag: "wx",
    });
  }

  /** Open a kept partial and cut it back to `to` bytes (the verified offset). */
  async truncate(ref: string, to: number): Promise<void> {
    await this.ready();
    const fh = await this.#handle(ref);
    await fh.truncate(to);
    this.#sizes.set(ref, to);
  }

  async write(ref: string, offset: number, data: Uint8Array): Promise<void> {
    // The bound holds at the write, not only at the offer: nothing grows the store past the quota
    // or into the volume's reserve.
    const growth = Math.max(
      0,
      offset + data.length - (this.#sizes.get(ref) ?? 0),
    );
    let total = 0;
    for (const n of this.#sizes.values()) total += n;
    if (
      total + growth > this.#quota ||
      (this.#disk !== null && this.#disk - growth < DISK_RESERVE)
    )
      throw new TransferStoreError("quota");
    const fh = await this.#handle(ref);
    let at = 0;
    while (at < data.length) {
      const { bytesWritten } = await fh.write(
        data,
        at,
        data.length - at,
        offset + at,
      );
      if (bytesWritten === 0) throw new TransferStoreError("short write");
      at += bytesWritten;
    }
    this.#sizes.set(ref, Math.max(this.#sizes.get(ref) ?? 0, offset + at));
    if (this.#disk !== null) this.#disk = Math.max(0, this.#disk - at);
  }

  async #handle(ref: string): Promise<FileHandle> {
    let fh = this.#handles.get(ref);
    if (fh === undefined) {
      fh = await open(this.#part(ref), fsc.O_RDWR | NOFOLLOW);
      this.#handles.set(ref, fh);
    }
    return fh;
  }

  /** Close the file and keep it (a session ended; the partial waits for a resume). */
  async keep(ref: string): Promise<void> {
    const fh = this.#handles.get(ref);
    this.#handles.delete(ref);
    await fh?.close().catch(() => undefined);
  }

  /** Close and remove a partial and its record. */
  async remove(ref: string): Promise<void> {
    await this.ready();
    await this.#drop(ref);
  }

  async #drop(ref: string): Promise<void> {
    const fh = this.#handles.get(ref);
    this.#handles.delete(ref);
    await fh?.close().catch(() => undefined);
    this.#sizes.delete(ref);
    await rm(this.#part(ref), { force: true });
    await rm(this.#meta(ref), { force: true });
  }

  /**
   * A hasher fed with the first `offset` bytes of a kept partial, read again now. Synchronous
   * because the machine asks for it in the middle of an `ACCEPT`; it throws when the file is
   * shorter than `offset`.
   */
  rehash(ref: string, offset: number): XferHasher {
    const h = new XferHasher();
    const fd = openSync(this.#part(ref), fsc.O_RDONLY | NOFOLLOW);
    try {
      const buf = Buffer.allocUnsafe(1024 * 1024);
      let at = 0;
      while (at < offset) {
        const n = readSync(fd, buf, 0, Math.min(buf.length, offset - at), at);
        if (n === 0) throw new TransferStoreError("the partial file is short");
        h.update(buf.subarray(0, n));
        at += n;
      }
    } finally {
      closeSync(fd);
    }
    return h;
  }

  // ── delivery ───────────────────────────────────────────────────────────────

  /** Hand a verified partial to the place the host named, then remove it. */
  async deliver(ref: string, to: DeliverTo): Promise<void> {
    await this.keep(ref);
    const part = this.#part(ref);
    if ("stream" in to) {
      await to.stream(createReadStream(part, { highWaterMark: 1024 * 1024 }));
    } else {
      await writeFileAtomic(to.saveTo, to.overwrite, (tmp) =>
        copyFile(part, tmp, fsc.COPYFILE_EXCL),
      );
    }
    await this.remove(ref);
  }

  // ── forgetting ─────────────────────────────────────────────────────────────

  /** Remove every partial of one peer key (a deleted link). */
  async purgePeer(peerKey: Uint8Array): Promise<void> {
    if (!(await exists(this.#root))) return;
    await this.ready();
    const peer = HEX(peerKey);
    for (const ref of [...this.#sizes.keys()]) {
      const meta = await this.#readMeta(ref);
      if (meta === null || meta.peer === peer) await this.#drop(ref);
    }
  }

  /** Remove everything (sign-out, deactivation). Nothing is left behind, not even the directory. */
  async purgeAll(): Promise<void> {
    for (const fh of this.#handles.values())
      await fh.close().catch(() => undefined);
    this.#handles.clear();
    this.#sizes.clear();
    this.#reserved.clear();
    this.#gen++;
    this.#ready = null;
    await rm(this.#root, { recursive: true, force: true });
  }

  /** A place for a one-pass stream the sender must hash before it offers it. */
  async spool(): Promise<{ path: string; fh: FileHandle }> {
    await this.ready();
    const path = join(this.spoolDir, randomBytes(16).toString("hex"));
    const fh = await open(
      path,
      fsc.O_RDWR | fsc.O_CREAT | fsc.O_EXCL | NOFOLLOW,
      0o600,
    );
    return { path, fh };
  }
}

const exists = (p: string): Promise<boolean> =>
  lstat(p).then(
    () => true,
    () => false,
  );

/**
 * Write a file the host named: `fill` writes a temporary file beside it (random name, never the
 * peer's), which is synced and moved into place. Without `overwrite` an existing file is kept and
 * the call fails.
 */
export async function writeFileAtomic(
  dest: string,
  overwrite: boolean,
  fill: (tmp: string) => Promise<void>,
): Promise<void> {
  if (!isAbsolute(dest))
    throw new TransferStoreError("the destination must be an absolute path");
  const dir = dirname(dest);
  const st = await stat(dir).catch(() => null);
  if (st === null || !st.isDirectory())
    throw new TransferStoreError("the destination folder does not exist");
  if (basename(dest) === "" || dest.endsWith("/"))
    throw new TransferStoreError("the destination must name a file");
  const tmp = join(dir, `.pkey-xfer-${randomBytes(8).toString("hex")}.tmp`);
  try {
    await fill(tmp);
    const fh = await open(tmp, fsc.O_RDWR | NOFOLLOW);
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
    if (overwrite) await rename(tmp, dest);
    else {
      await link(tmp, dest);
      await unlink(tmp);
    }
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

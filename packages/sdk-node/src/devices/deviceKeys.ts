// The Node device key store (CC-26.2; plans/CC-01.md R-5): custody of one device's Ed25519
// signing key and X25519 agreement key behind client-core's `DeviceKeyPort`. Keys are made on
// first need and never leave the port: callers get public halves, signatures and shared secrets.
// Mirrors the Kotlin JVM store (`FileDeviceKeyStorage` + `DeviceKeyStore`).
//
// Rules this store keeps:
//  - a record that exists but cannot be used is an ERROR (`DeviceKeysUnreadableError`), never
//    replaced: only `wipe()` resets it, so the device identity never changes silently;
//  - an I/O fault, a refused path or a lock timeout throws `DeviceKeyStoreError` and never reads
//    as "no record" (a glitch must not cost the keys or make a second pair);
//  - `ensure`, `rotate` and `wipe` run under a lock file, so two processes cannot both create a
//    pair or repeat a generation;
//  - the file is `0600` in a `0700` directory; a directory or file owned by someone else, a
//    directory with any group or other bit, a file others may touch, a symlink, and an ancestor
//    (up to the home directory) that others may write without the sticky bit are refused;
//  - on Windows the owner and mode checks, `O_NOFOLLOW` and the directory fsync are skipped (the
//    user profile's ACL is the protection); renames are retried on EPERM/EBUSY;
//  - the private halves are held in zeroed buffers for one operation and are in no return value,
//    log or error text.

import {
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  randomBytes,
  sign as edSign,
  type KeyObject,
} from "node:crypto";
import {
  type Stats,
  closeSync,
  constants as fsc,
  fstatSync,
  fsyncSync,
  fchmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { homedir, hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  isX25519LowOrder,
} from "@polaris-key/jws";
import {
  DeviceKeyUnsupportedError,
  DeviceKeysUnreadableError,
  type DeviceKeyPort,
  type DevicePublicKeys,
} from "@polaris-key/client-core";
import { resolveDirs } from "../core/dirs.js";

export { DeviceKeysUnreadableError };

/**
 * The store could not be used right now: an I/O fault, a path it refuses (foreign owner, loose
 * mode, symlink), or a lock it could not take. Nothing was changed, and nothing reads as "no
 * keys".
 */
export class DeviceKeyStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceKeyStoreError";
  }
}

export type DeviceKeyPersistence = "durable" | "memory";

/** Holds the one record of a key store. `update` is a read-modify-write under the storage lock. */
export interface NodeDeviceKeyStorage {
  readonly persistence: DeviceKeyPersistence;
  /**
   * Runs `transform` on the current record (null when none) under the lock; the bytes it answers
   * are written, null leaves the record alone. True when it wrote. A throw writes nothing.
   */
  update(
    transform: (current: Buffer | null) => Buffer | null,
  ): Promise<boolean>;
  /** The record, null when none. Throws `DeviceKeyStoreError` for a fault, never null for one. */
  get(): Promise<Buffer | null>;
  /** Overwrites the record with zeros and removes it. */
  clear(): Promise<void>;
}

/** Process memory only: the keys die with the process. */
export class InMemoryDeviceKeyStorage implements NodeDeviceKeyStorage {
  readonly persistence = "memory" as const;
  private record: Buffer | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => T): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  get(): Promise<Buffer | null> {
    return this.serial(() => (this.record ? Buffer.from(this.record) : null));
  }

  update(
    transform: (current: Buffer | null) => Buffer | null,
  ): Promise<boolean> {
    return this.serial(() => {
      const next = transform(this.record ? Buffer.from(this.record) : null);
      if (!next) return false;
      this.record?.fill(0);
      this.record = Buffer.from(next);
      return true;
    });
  }

  clear(): Promise<void> {
    return this.serial(() => {
      this.record?.fill(0);
      this.record = null;
    });
  }
}

const MAX_BYTES = 64 * 1024;
const LOCK_STALE_MS = 30_000;
const LOCK_DEAD_GRACE_MS = 5_000;
const LOCK_TIMEOUT_MS = 10_000;
const isWindows = process.platform === "win32";
const ownUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/**
 * Identifies this boot and pid namespace (Linux: the boot id plus the pid-namespace inode), so a
 * pid recorded in a lock is believed only by a process that shares it. Null elsewhere: a lock is
 * then judged by age alone.
 */
function bootId(): string | null {
  if (process.platform !== "linux") return null;
  try {
    return `${readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()}:${readlinkSync("/proc/self/ns/pid")}`;
  } catch {
    return null;
  }
}

/** In-process serialisation per path (the lock file is not re-entrant within one process). */
const MUTEXES = new Map<string, Promise<unknown>>();

async function withMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = MUTEXES.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  MUTEXES.set(key, tail);
  try {
    return await run;
  } finally {
    if (MUTEXES.get(key) === tail) MUTEXES.delete(key);
  }
}

/** `rename`, retried a few times where Windows briefly refuses (EPERM/EBUSY: a scanner holds it). */
function renameRetry(from: string, to: string): void {
  for (let i = 0; ; i++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (!isWindows || (code !== "EPERM" && code !== "EBUSY") || i >= 5)
        throw e;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        20 * (i + 1),
      );
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

function fault(what: string, path: string, e: unknown): DeviceKeyStoreError {
  const code = (e as NodeJS.ErrnoException)?.code;
  return new DeviceKeyStoreError(
    `device keys: could not ${what} ${path}${code ? ` (${code})` : ""}`,
  );
}

/**
 * The record in one file, `0600` in a `0700` directory, replaced atomically (a temporary file made
 * owner-only before its first byte, fsynced, then renamed over). A lock file serialises
 * `update`/`get`/`clear` between processes. Every temporary file is overwritten with zeros before
 * it is deleted.
 */
export class FileDeviceKeyStorage implements NodeDeviceKeyStorage {
  readonly persistence = "durable" as const;
  private readonly dir: string;
  private readonly name: string;
  private readonly lockPath: string;

  constructor(private readonly file: string) {
    this.dir = dirname(file);
    this.name = basename(file);
    this.lockPath = join(this.dir, `.${this.name}.lock`);
  }

  private locked<T>(block: () => T): Promise<T> {
    return withMutex(this.file, async () => {
      this.ensureDirectory();
      this.checkTrusted(this.dir, false);
      const release = await this.acquire();
      try {
        this.checkTrusted(this.dir, true);
        return block();
      } finally {
        release();
      }
    });
  }

  get(): Promise<Buffer | null> {
    return this.locked(() => this.read());
  }

  update(
    transform: (current: Buffer | null) => Buffer | null,
  ): Promise<boolean> {
    return this.locked(() => {
      const current = this.read();
      let next: Buffer | null;
      try {
        next = transform(current);
      } finally {
        current?.fill(0);
      }
      if (!next) return false;
      try {
        this.write(next);
      } finally {
        next.fill(0);
      }
      return true;
    });
  }

  clear(): Promise<void> {
    return this.locked(() => {
      const st = this.lstatMaybe(this.file);
      if (st) {
        this.refuseNonRegular(this.file, st);
        this.zeroAndDelete(this.file);
      }
      this.sweepTemporaries();
    });
  }

  // ---- directory and file checks -------------------------------------------------------------

  private ensureDirectory(): void {
    let st = this.lstatMaybe(this.dir);
    if (!st) {
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        if (!isWindows) chmodSync(this.dir, 0o700);
      } catch (e) {
        throw fault("create", this.dir, e);
      }
      st = this.lstatMaybe(this.dir);
    }
    if (!st || st.isSymbolicLink() || !st.isDirectory())
      throw new DeviceKeyStoreError(
        `device keys: ${this.dir} is not a directory`,
      );
  }

  /** Refuses a directory or file that this user does not own or that others may touch. */
  private checkTrusted(dir: string, includeFiles: boolean): void {
    if (isWindows) return;
    const uid = ownUid();
    const dst = this.lstatMaybe(dir);
    if (!dst) throw new DeviceKeyStoreError(`device keys: ${dir} is gone`);
    if (uid !== null && dst.uid !== uid)
      throw new DeviceKeyStoreError(
        `device keys: refusing a directory owned by another user: ${dir}`,
      );
    if ((dst.mode & 0o077) !== 0)
      throw new DeviceKeyStoreError(
        `device keys: refusing a directory others may access: ${dir}`,
      );
    this.checkAncestors(dir);
    if (!includeFiles) return;
    for (const f of [this.file, this.lockPath]) {
      const st = this.lstatMaybe(f);
      if (!st) continue;
      this.refuseNonRegular(f, st);
      if (uid !== null && st.uid !== uid)
        throw new DeviceKeyStoreError(
          `device keys: refusing a file owned by another user: ${f}`,
        );
      if ((st.mode & 0o077) !== 0)
        throw new DeviceKeyStoreError(
          `device keys: refusing a file others may access: ${f}`,
        );
    }
  }

  /**
   * Refuses a group- or world-writable ancestor without the sticky bit, from the real path of the
   * directory up to the home directory (or the root): someone who can write there can swap the
   * directory out. A world-writable parent without the sticky bit is unsupported.
   */
  private checkAncestors(dir: string): void {
    let real: string;
    try {
      real = realpathSync(dir);
    } catch (e) {
      throw fault("resolve", dir, e);
    }
    let home: string | null = null;
    try {
      home = realpathSync(homedir());
    } catch {
      // no home: walk to the root
    }
    for (let p = dirname(real); ; p = dirname(p)) {
      if (p === home) return;
      const st = this.lstatMaybe(p);
      if (st && (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0)
        throw new DeviceKeyStoreError(
          `device keys: refusing a directory under one others may write: ${p}`,
        );
      if (dirname(p) === p) return;
    }
  }

  private refuseNonRegular(f: string, st: Stats): void {
    if (st.isSymbolicLink() || !st.isFile())
      throw new DeviceKeyStoreError(
        `device keys: refusing a path that is not a regular file: ${f}`,
      );
  }

  private lstatMaybe(f: string): Stats | null {
    try {
      return lstatSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw fault("examine", f, e);
    }
  }

  // ---- the lock ------------------------------------------------------------------------------
  //
  // Taken with the hard-link primitive: the body is written to a private temporary file, then
  // `link(tmp, lock)` publishes it, atomically and with its content (a half-written lock is never
  // visible). A stale lock is reclaimed by renaming it to a name derived from the token we
  // observed, so two reclaimers cannot both win; if what moved is not what we observed, we back
  // off and never put it back. The holder re-verifies its token just before it renames the new
  // record into place. Stale-lock reclaim is best effort on a network home (clock and file
  // semantics there are the server's); keep the state directory on a local disk.

  private held: string | null = null;

  private async acquire(): Promise<() => void> {
    const token = randomBytes(16).toString("hex");
    const body = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      boot: bootId(),
      token,
    });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      if (this.tryLink(body)) {
        this.held = token;
        return () => this.release(token);
      }
      this.checkTrusted(this.dir, true);
      this.reclaimIfStale();
      if (Date.now() > deadline)
        throw new DeviceKeyStoreError("device keys: the lock is busy");
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }

  /** Makes a private temp file with `body`; link it to the lock path. True when we hold the lock. */
  private tryLink(body: string): boolean {
    const tmp = this.tempPath("lk");
    try {
      this.createPrivate(tmp, Buffer.from(body));
      try {
        linkSync(tmp, this.lockPath);
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw fault("lock", this.lockPath, e);
      }
    } finally {
      // Not zeroed: after a successful link this is the lock's own inode. It holds no key.
      try {
        unlinkSync(tmp);
      } catch {
        // gone already
      }
    }
  }

  private tempPath(ext: string): string {
    return join(
      this.dir,
      `.${this.name}.${randomBytes(8).toString("hex")}.${ext}`,
    );
  }

  /** Creates `path` exclusively, owner-only before the first byte, and fsyncs it. */
  private createPrivate(path: string, bytes: Buffer): void {
    const fd = openSync(
      path,
      fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0),
      0o600,
    );
    try {
      if (!isWindows) fchmodSync(fd, 0o600);
      let off = 0;
      while (off < bytes.length)
        off += writeSync(fd, bytes, off, bytes.length - off);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  /** The file system's own clock: the mtime of a file made now (never `Date.now()`). */
  private fsNow(): number {
    const probe = this.tempPath("lk");
    try {
      this.createPrivate(probe, Buffer.alloc(0));
      return statSync(probe).mtimeMs;
    } catch {
      return Date.now();
    } finally {
      this.zeroAndDelete(probe);
    }
  }

  private release(token: string): void {
    this.held = null;
    // Only our own lock: rename it aside, check what moved, then remove it. A lock that is no
    // longer ours (reclaimed as stale) is left to its new holder.
    if (this.readLock(this.lockPath)?.token !== token) return;
    const aside = join(this.dir, `.${this.name}.lock.${token}.stale`);
    try {
      renameSync(this.lockPath, aside);
    } catch {
      return;
    }
    this.zeroAndDelete(aside);
  }

  private readLock(path: string): {
    pid?: number;
    host?: string;
    boot?: string | null;
    token?: string;
  } | null {
    let fd: number;
    try {
      fd = openSync(path, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, 512, 0);
      const o: unknown = JSON.parse(buf.toString("utf8", 0, n));
      return o && typeof o === "object" ? (o as { token?: string }) : null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** Moves a dead or expired lock aside (atomic rename to a token-named file), then checks it. */
  private reclaimIfStale(): void {
    const st = this.lstatMaybe(this.lockPath);
    if (!st) return;
    this.refuseNonRegular(this.lockPath, st);
    const seen = this.readLock(this.lockPath);
    const age = this.fsNow() - st.mtimeMs;
    // A dead pid counts only past a grace period, and only on the same host and boot (pid
    // namespace); elsewhere the age alone decides.
    let dead = false;
    const boot = bootId();
    if (
      seen &&
      typeof seen.pid === "number" &&
      seen.host === hostname() &&
      boot !== null &&
      seen.boot === boot &&
      age > LOCK_DEAD_GRACE_MS
    ) {
      try {
        process.kill(seen.pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (age <= LOCK_STALE_MS && !dead) return;
    // An unreadable lock has no token to name the file by; only the age rule applies to it.
    const tag = seen?.token ?? randomBytes(8).toString("hex");
    const aside = join(this.dir, `.${this.name}.lock.${tag}.stale`);
    try {
      renameSync(this.lockPath, aside);
    } catch {
      return; // someone else reclaimed it first
    }
    // If what moved is not what we observed, a live holder's lock went with it: do not put it
    // back (that could admit two holders); the holder sees its token gone and aborts its write.
    this.zeroAndDelete(aside);
  }

  // ---- read and write ------------------------------------------------------------------------

  private read(): Buffer | null {
    let fd: number;
    try {
      fd = openSync(this.file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP")
        throw new DeviceKeyStoreError(
          `device keys: refusing a symlink: ${this.file}`,
        );
      throw fault("read", this.file, e);
    }
    try {
      const st = fstatSync(fd);
      const uid = ownUid();
      if (!st.isFile())
        throw new DeviceKeyStoreError(
          `device keys: refusing a path that is not a regular file: ${this.file}`,
        );
      if (!isWindows && uid !== null && st.uid !== uid)
        throw new DeviceKeyStoreError(
          `device keys: refusing a file owned by another user: ${this.file}`,
        );
      if (!isWindows && (st.mode & 0o077) !== 0)
        throw new DeviceKeyStoreError(
          `device keys: refusing a file others may access: ${this.file}`,
        );
      if (st.size > MAX_BYTES)
        throw new DeviceKeysUnreadableError(
          "device keys: the record is not one of ours",
        );
      const buf = Buffer.alloc(st.size);
      let got = 0;
      for (let n = 1; n > 0 && got < buf.length; got += n)
        n = readSync(fd, buf, got, buf.length - got, got);
      return buf.subarray(0, got);
    } catch (e) {
      if (
        e instanceof DeviceKeyStoreError ||
        e instanceof DeviceKeysUnreadableError
      )
        throw e;
      throw fault("read", this.file, e);
    } finally {
      closeSync(fd);
    }
  }

  private write(bytes: Buffer): void {
    const lst = this.lstatMaybe(this.file);
    if (lst) this.refuseNonRegular(this.file, lst);
    this.sweepTemporaries();
    const tmp = join(
      this.dir,
      `.${this.name}.${randomBytes(8).toString("hex")}.tmp`,
    );
    try {
      this.createPrivate(tmp, bytes); // owner-only before the first key byte
      if (
        this.held !== null &&
        this.readLock(this.lockPath)?.token !== this.held
      )
        throw new DeviceKeyStoreError("device keys: the lock was lost");
      renameRetry(tmp, this.file);
      this.syncDirectory();
    } catch (e) {
      this.zeroAndDelete(tmp);
      if (e instanceof DeviceKeyStoreError) throw e;
      throw fault("write", this.file, e);
    }
  }

  private syncDirectory(): void {
    if (isWindows) return;
    try {
      const fd = openSync(this.dir, fsc.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch {
      // not every file system lets a directory be synced
    }
  }

  /** Removes stale temporary files (a crashed write); the lock is held, so none is in use. */
  private sweepTemporaries(): void {
    let names: string[];
    try {
      names = readdirSync(this.dir);
    } catch (e) {
      throw fault("list", this.dir, e);
    }
    const prefix = `.${this.name}.`;
    for (const n of names) {
      if (!n.startsWith(prefix)) continue;
      // Record temporaries exist only under the lock, so any left is a crashed write's. Lock
      // temporaries and moved-aside locks are other contenders' work in flight: only old ones go.
      if (n.endsWith(".tmp")) this.zeroAndDelete(join(this.dir, n));
      else if (n.endsWith(".lk") || n.endsWith(".stale")) {
        const st = this.lstatMaybe(join(this.dir, n));
        if (st && Date.now() - st.mtimeMs > 60_000)
          this.zeroAndDelete(join(this.dir, n));
      }
    }
  }

  /** Overwrites a regular file we own with zeros, then deletes it. Best effort on the overwrite. */
  private zeroAndDelete(f: string): void {
    try {
      const fd = openSync(f, fsc.O_RDWR | (fsc.O_NOFOLLOW ?? 0));
      try {
        const st = fstatSync(fd);
        const uid = ownUid();
        if (st.isFile() && (isWindows || uid === null || st.uid === uid)) {
          const zero = Buffer.alloc(Math.min(st.size, MAX_BYTES));
          if (zero.length > 0) {
            writeSync(fd, zero, 0, zero.length, 0);
            fsyncSync(fd);
          }
        }
      } finally {
        closeSync(fd);
      }
    } catch {
      // a file we cannot open is still removed below when it is ours to remove
    }
    try {
      unlinkSync(f);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT")
        throw fault("delete", f, e);
    }
  }
}

// ---- the key store -----------------------------------------------------------------------------

const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

function edPrivate(seed: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_ED25519, seed]),
    format: "der",
    type: "pkcs8",
  });
}
function xPrivate(priv: Buffer): KeyObject {
  return createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, priv]),
    format: "der",
    type: "pkcs8",
  });
}
function publicOf(k: KeyObject): Buffer {
  const x = createPublicKey(k).export({ format: "jwk" }).x;
  return Buffer.from(base64UrlDecode(x as string));
}

interface KeyRecord {
  generation: number;
  seed: Buffer;
  signPub: Buffer;
  agreePriv: Buffer;
  agreePub: Buffer;
}

const zero = (r: KeyRecord): void => {
  r.seed.fill(0);
  r.agreePriv.fill(0);
};
const publicKeysOf = (r: KeyRecord): DevicePublicKeys => ({
  signKey: base64UrlEncodeBytes(r.signPub),
  agreeKey: base64UrlEncodeBytes(r.agreePub),
  generation: r.generation,
});

function decodeKey(v: unknown): Buffer | null {
  if (typeof v !== "string" || v.length !== 43) return null;
  try {
    const b = base64UrlDecode(v);
    // Canonical only: the same text must come back out.
    if (b.length !== 32 || base64UrlEncodeBytes(b) !== v) return null;
    return Buffer.from(b);
  } catch {
    return null;
  }
}

function consistent(r: KeyRecord): boolean {
  try {
    return (
      publicOf(edPrivate(r.seed)).equals(r.signPub) &&
      publicOf(xPrivate(r.agreePriv)).equals(r.agreePub)
    );
  } catch {
    return false;
  }
}

function generate(generation: number): KeyRecord {
  let seedKey: KeyObject;
  let agreeKey: KeyObject;
  try {
    seedKey = generateKeyPairSync("ed25519").privateKey;
    agreeKey = generateKeyPairSync("x25519").privateKey;
  } catch {
    throw new DeviceKeyUnsupportedError("no Ed25519 or X25519 here");
  }
  const seed = Buffer.from(
    base64UrlDecode(seedKey.export({ format: "jwk" }).d as string),
  );
  const agreePriv = Buffer.from(
    base64UrlDecode(agreeKey.export({ format: "jwk" }).d as string),
  );
  const rec: KeyRecord = {
    generation,
    seed,
    signPub: publicOf(seedKey),
    agreePriv,
    agreePub: publicOf(agreeKey),
  };
  if (isX25519LowOrder(rec.agreePub) || !consistent(rec)) {
    zero(rec);
    throw new DeviceKeyUnsupportedError("the curve backend is inconsistent");
  }
  return rec;
}

function encode(r: KeyRecord): Buffer {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      generation: r.generation,
      sign: {
        seed: base64UrlEncodeBytes(r.seed),
        pub: base64UrlEncodeBytes(r.signPub),
      },
      agree: {
        priv: base64UrlEncodeBytes(r.agreePriv),
        pub: base64UrlEncodeBytes(r.agreePub),
      },
    }),
    "utf8",
  );
}

function parse(raw: Buffer): KeyRecord | null {
  let o: unknown;
  try {
    o = JSON.parse(raw.toString("utf8"));
  } catch {
    return null; // never surface the parser's message: it can quote the text
  }
  if (!o || typeof o !== "object") return null;
  const t = o as { [k: string]: unknown };
  if (t.v !== 1) return null;
  const gen = t.generation;
  if (typeof gen !== "number" || !Number.isSafeInteger(gen) || gen < 1)
    return null;
  const sign = t.sign as { [k: string]: unknown } | undefined;
  const agree = t.agree as { [k: string]: unknown } | undefined;
  if (!sign || typeof sign !== "object" || !agree || typeof agree !== "object")
    return null;
  const seed = decodeKey(sign.seed);
  const signPub = decodeKey(sign.pub);
  const agreePriv = decodeKey(agree.priv);
  const agreePub = decodeKey(agree.pub);
  if (!seed || !signPub || !agreePriv || !agreePub) {
    seed?.fill(0);
    agreePriv?.fill(0);
    return null;
  }
  const rec: KeyRecord = {
    generation: gen,
    seed,
    signPub,
    agreePriv,
    agreePub,
  };
  if (!consistent(rec)) {
    zero(rec);
    return null;
  }
  return rec;
}

export interface NodeDeviceKeyStoreOptions {
  /** The record's home. Default: `FileDeviceKeyStorage` at `<state dir>/device-keys.json`. */
  storage?: NodeDeviceKeyStorage;
  /** The product slug, for the default state directory. Ignored when `storage` is given. */
  product?: string;
  /** Overrides the state directory base (as the client's `stateDir`). */
  stateDir?: string;
  /** Hold the keys in process memory only. Such a store refuses to register keys. */
  memory?: boolean;
}

export interface NodeDeviceKeyStore extends DeviceKeyPort {
  persistence(): DeviceKeyPersistence;
}

/** Key store over a `NodeDeviceKeyStorage`; see the file header for the rules it keeps. */
export function createNodeDeviceKeyStore(
  opts: NodeDeviceKeyStoreOptions = {},
): NodeDeviceKeyStore {
  let storage = opts.storage;
  if (!storage) {
    if (opts.memory) storage = new InMemoryDeviceKeyStorage();
    else {
      if (!opts.product)
        throw new DeviceKeyStoreError(
          "device keys: a product or a storage is needed",
        );
      const dirs = resolveDirs(
        opts.product,
        opts.stateDir ? { stateDir: opts.stateDir } : {},
      );
      storage = new FileDeviceKeyStorage(join(dirs.state, "device-keys.json"));
    }
  }
  const store = storage;

  async function load(): Promise<KeyRecord | null> {
    const raw = await store.get();
    if (!raw) return null;
    try {
      const r = parse(raw);
      if (!r) throw new DeviceKeysUnreadableError();
      return r;
    } finally {
      raw.fill(0);
    }
  }

  // One operation at a time within this process; the storage lock covers other processes.
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = tail.then(fn, fn);
    tail = run.catch(() => undefined);
    return run;
  };

  return {
    persistence: () => store.persistence,

    publicKeys: () =>
      exclusive(async () => {
        const r = await load();
        if (!r) return null;
        const out = publicKeysOf(r);
        zero(r);
        return out;
      }),

    ensure: () =>
      exclusive(async () => {
        let result: DevicePublicKeys | undefined;
        // Under the storage lock: an existing record is returned (an unreadable one throws);
        // only an absent one is created, so two processes can never each make a pair.
        await store.update((current) => {
          if (current) {
            const r = parse(current);
            if (!r) throw new DeviceKeysUnreadableError();
            result = publicKeysOf(r);
            zero(r);
            return null;
          }
          const fresh = generate(1);
          result = publicKeysOf(fresh);
          const bytes = encode(fresh);
          zero(fresh);
          return bytes;
        });
        return result!;
      }),

    sign: (message) =>
      exclusive(async () => {
        const r = await load();
        if (!r) throw new Error("device keys: none yet");
        try {
          return new Uint8Array(edSign(null, message, edPrivate(r.seed)));
        } finally {
          zero(r);
        }
      }),

    dh: (peerPublic) =>
      exclusive(async () => {
        if (peerPublic.length !== 32 || isX25519LowOrder(peerPublic))
          return null;
        const r = await load();
        if (!r) return null;
        try {
          const peer = createPublicKey({
            key: Buffer.concat([SPKI_X25519, peerPublic]),
            format: "der",
            type: "spki",
          });
          const secret = diffieHellman({
            privateKey: xPrivate(r.agreePriv),
            publicKey: peer,
          });
          if (secret.every((b) => b === 0)) return null;
          return new Uint8Array(secret);
        } catch {
          return null;
        } finally {
          zero(r);
        }
      }),

    rotate: () =>
      exclusive(async () => {
        let result: DevicePublicKeys | undefined;
        // The generation is read and its successor written under the storage lock, so a
        // concurrent rotate (another process) is neither lost nor repeats a generation.
        await store.update((current) => {
          let prev: KeyRecord | null = null;
          if (current) {
            prev = parse(current);
            if (!prev) throw new DeviceKeysUnreadableError();
          }
          const gen = (prev?.generation ?? 0) + 1;
          if (prev) zero(prev);
          const fresh = generate(gen);
          result = publicKeysOf(fresh);
          const bytes = encode(fresh);
          zero(fresh);
          return bytes;
        });
        return result!;
      }),

    wipe: () => exclusive(() => store.clear()),
  };
}

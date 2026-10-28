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
//    directory others may write, a file others may touch, and a symlink are refused;
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
  readSync,
  renameSync,
  unlinkSync,
  writeSync,
  chmodSync,
} from "node:fs";
import { hostname } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  base64UrlDecode,
  base64UrlEncodeBytes,
  isX25519LowOrder,
} from "@polaris-key/jws";
import {
  DeviceKeyUnsupportedError,
  type DeviceKeyPort,
  type DevicePublicKeys,
} from "@polaris-key/client-core";
import { resolveDirs } from "../core/dirs.js";

/**
 * The stored key record exists but cannot be used (it does not parse, its public halves do not
 * match its private halves, or it is not one of ours). It is never replaced automatically: only
 * `wipe()` clears it, after which `ensure()` makes a new pair.
 */
export class DeviceKeysUnreadableError extends Error {
  constructor(message = "device keys: the record is unreadable") {
    super(message);
    this.name = "DeviceKeysUnreadableError";
  }
}

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
const LOCK_TIMEOUT_MS = 10_000;
const isWindows = process.platform === "win32";
const ownUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

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
    if ((dst.mode & 0o022) !== 0)
      throw new DeviceKeyStoreError(
        `device keys: refusing a directory others may write: ${dir}`,
      );
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

  private async acquire(): Promise<() => void> {
    const token = randomBytes(16).toString("hex");
    const body = JSON.stringify({
      pid: process.pid,
      host: hostname(),
      token,
    });
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(
          this.lockPath,
          fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0),
          0o600,
        );
        try {
          if (!isWindows) fchmodSync(fd, 0o600);
          writeSync(fd, body);
        } finally {
          closeSync(fd);
        }
        return () => this.release(token);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST")
          throw fault("lock", this.lockPath, e);
      }
      this.checkTrusted(this.dir, true);
      this.reclaimIfStale();
      if (Date.now() > deadline)
        throw new DeviceKeyStoreError("device keys: the lock is busy");
      await sleep(15 + Math.floor(Math.random() * 25));
    }
  }

  private release(token: string): void {
    // Only our own lock: if it was reclaimed as stale, the new holder's file stays.
    if (this.readLock()?.token !== token) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      // gone already
    }
  }

  private readLock(): { pid?: number; host?: string; token?: string } | null {
    let fd: number;
    try {
      fd = openSync(this.lockPath, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
    } catch {
      return null;
    }
    try {
      const buf = Buffer.alloc(512);
      const n = readSync(fd, buf, 0, 512, 0);
      const o: unknown = JSON.parse(buf.toString("utf8", 0, n));
      return o && typeof o === "object"
        ? (o as { pid?: number; host?: string; token?: string })
        : null;
    } catch {
      return null;
    } finally {
      closeSync(fd);
    }
  }

  /** Moves a dead or expired lock aside (atomic rename), after checking what was moved. */
  private reclaimIfStale(): void {
    const st = this.lstatMaybe(this.lockPath);
    if (!st) return;
    this.refuseNonRegular(this.lockPath, st);
    const seen = this.readLock();
    const old = Date.now() - st.mtimeMs > LOCK_STALE_MS;
    let dead = false;
    if (seen && typeof seen.pid === "number" && seen.host === hostname()) {
      try {
        process.kill(seen.pid, 0);
      } catch (e) {
        dead = (e as NodeJS.ErrnoException).code === "ESRCH";
      }
    }
    if (!old && !dead) return;
    const aside = join(
      this.dir,
      `.${this.name}.${randomBytes(6).toString("hex")}.stale`,
    );
    try {
      renameSync(this.lockPath, aside);
    } catch {
      return; // someone else reclaimed it first
    }
    // If a live holder's fresh lock was what moved, put it back (link fails if a new one exists).
    const moved = this.readAside(aside);
    if (moved && seen?.token && moved !== seen.token) {
      try {
        linkSync(aside, this.lockPath);
      } catch {
        // a newer lock exists; the displaced holder's release will find its token gone
      }
    }
    this.zeroAndDelete(aside);
  }

  private readAside(p: string): string | undefined {
    try {
      const fd = openSync(p, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
      try {
        const buf = Buffer.alloc(512);
        const n = readSync(fd, buf, 0, 512, 0);
        return (JSON.parse(buf.toString("utf8", 0, n)) as { token?: string })
          .token;
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
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
      const fd = openSync(
        tmp,
        fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0),
        0o600,
      );
      try {
        if (!isWindows) fchmodSync(fd, 0o600); // before the first key byte
        let off = 0;
        while (off < bytes.length)
          off += writeSync(fd, bytes, off, bytes.length - off);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(tmp, this.file);
      this.syncDirectory();
    } catch (e) {
      this.zeroAndDelete(tmp);
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
    for (const n of names)
      if (n.startsWith(prefix) && (n.endsWith(".tmp") || n.endsWith(".stale")))
        this.zeroAndDelete(join(this.dir, n));
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

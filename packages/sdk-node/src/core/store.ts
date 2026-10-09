// Persistence: the per-device `pkeyt_` token and the Core-owned offline cache record.
//
// The SHAPE of what is stored (`Store`, `CacheRecordV3`, `CACHE_VERSION`) is isomorphic and
// lives in `@polaris-key/client-core`; only the Node-flavoured implementations are here. The default
// `KeyringStore` keeps the token in the OS keyring when one is available and falls back to
// explicit 0600 file storage for headless/CI hosts, and its `status()` says which; tests use
// `InMemoryStore`.
//
// A store is DUMB on purpose: it round-trips bytes and knows nothing about versions, verification
// or migration. Discarding a `v !== 3` record is `CacheManager`'s decision (§4.1), because that
// is a security rule, and a security rule that lived in three store implementations would be a
// security rule with three chances to be wrong.

import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants as fsc,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  CACHE_VERSION,
  type CacheRecordV3,
  type Store,
  type StoreStatus,
} from "@polaris-key/client-core";
import {
  deriveDeviceId,
  deviceIdFromRaw,
  rawDeviceId,
} from "../devices/deviceId.js";
import { printAs, REDACTED } from "./redact.js";
import { assertProductSlug } from "./slug.js";

export { CACHE_VERSION };
export type { CacheRecordV3, Store, StoreStatus };

/** In-memory store for tests. */
export class InMemoryStore implements Store {
  private token: string | null = null;
  private cache: CacheRecordV3 | null = null;
  private deviceId: string;

  constructor(productSlug = "test") {
    this.deviceId = deriveDeviceId(productSlug);
    // Prints whether a token is held, never the token (SP-46).
    printAs(this, () => ({
      deviceId: this.deviceId,
      token: this.token === null ? null : REDACTED,
    }));
  }
  async getToken() {
    return this.token;
  }
  async setToken(t: string) {
    this.token = t;
  }
  async clearToken() {
    this.token = null;
  }
  async getDeviceId() {
    return this.deviceId;
  }
  async readCache() {
    return this.cache;
  }
  async writeCache(rec: CacheRecordV3) {
    this.cache = rec;
  }
  async clearCache() {
    this.cache = null;
  }
  async status(): Promise<StoreStatus> {
    return { backend: "memory" };
  }
}

const isWindows = process.platform === "win32";
const ownUid = (): number | null =>
  typeof process.getuid === "function" ? process.getuid() : null;

/** Write `data` to `path` atomically: a 0600 temp file in the same directory (created
 *  exclusively, so a planted file or symlink at its name is refused), flushed, then renamed
 *  over the target. A crash leaves the old file or the new one, never a torn one, and a
 *  symlink planted at `path` is replaced, never followed. */
function writeSecure(path: string, data: string): void {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(
    tmp,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      if (!isWindows) fchmodSync(fd, 0o600);
      writeSync(fd, data);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** Read a regular file we own without following a symlink at `path`. Anything else
 *  reads as absent. */
function readMaybe(path: string): string | null {
  let fd: number;
  try {
    fd = openSync(path, fsc.O_RDONLY | fsc.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    const uid = ownUid();
    if (!st.isFile() || (uid !== null && st.uid !== uid)) return null;
    return readFileSync(fd, "utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Create the state directory at 0700 and make an existing one so; refuse a symlink or a
 *  directory another user owns. Files already in it are brought to 0600. */
function secureDir(dir: string, files: string[]): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (isWindows) return;
  const st = lstatSync(dir);
  const uid = ownUid();
  if (!st.isDirectory() || (uid !== null && st.uid !== uid)) {
    throw new Error(
      `The state directory ${dir} is not a directory this user owns.`,
    );
  }
  chmodSync(dir, 0o700);
  for (const f of files) {
    try {
      const fst = lstatSync(f);
      if (fst.isFile() && (uid === null || fst.uid === uid))
        chmodSync(f, 0o600);
    } catch {
      // absent
    }
  }
}

/** What a stored device id may look like: it rides in a header, so no whitespace or controls. */
const DEVICE_ID_SHAPE = /^[A-Za-z0-9_-]{1,64}$/;

export interface FileStoreOptions {
  /** Where the hardware anchor comes from. Default: the platform probe (`rawDeviceId`). A
   *  test seam: a test that plants a fixed device id passes `() => null` ("no anchor is
   *  readable", so the stored id is used). Hosts never need it. */
  readAnchor?: () => string | null;
}

/** 0600 file-backed store under `<configDir>/<product>/`. */
export class FileStore implements Store {
  private readonly dir: string;
  private readonly tokenPath: string;
  private readonly cachePath: string;
  private readonly devicePath: string;
  private readonly anchor: () => string | null;

  constructor(
    private readonly productSlug: string,
    configDir: string,
    options: FileStoreOptions = {},
  ) {
    this.anchor = options.readAnchor ?? (() => rawDeviceId());
    assertProductSlug(productSlug);
    this.dir = join(configDir, productSlug);
    this.tokenPath = join(this.dir, "token");
    this.cachePath = join(this.dir, "managed.json");
    this.devicePath = join(this.dir, "device");
    secureDir(this.dir, [this.tokenPath, this.cachePath, this.devicePath]);
  }

  async getToken() {
    return readMaybe(this.tokenPath)?.trim() || null;
  }
  async setToken(t: string) {
    writeSecure(this.tokenPath, t);
  }
  async clearToken() {
    rmSync(this.tokenPath, { force: true });
  }
  async getDeviceId() {
    const existing = readMaybe(this.devicePath)?.trim();
    if (existing && DEVICE_ID_SHAPE.test(existing)) return existing;
    const id = deviceIdFromRaw(this.productSlug, this.anchor() ?? randomUUID());
    writeSecure(this.devicePath, id);
    return id;
  }
  /** The hardware anchor this store binds its device id to. */
  readAnchor() {
    return this.anchor();
  }
  /** Rewrite the stored id (device binding). */
  async setDeviceId(id: string) {
    writeSecure(this.devicePath, id);
  }
  async readCache(): Promise<CacheRecordV3 | null> {
    const raw = readMaybe(this.cachePath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheRecordV3;
    } catch {
      return null;
    }
  }
  async writeCache(rec: CacheRecordV3) {
    writeSecure(this.cachePath, JSON.stringify(rec));
  }
  async clearCache() {
    rmSync(this.cachePath, { force: true });
  }
  /** The host chose a file, so it is not degraded. */
  async status(): Promise<StoreStatus> {
    return { backend: "file" };
  }
}

type KeyringModule = Pick<typeof import("@napi-rs/keyring"), "AsyncEntry">;

/** The three `AsyncEntry` operations the store uses (`@napi-rs/keyring` 2.x semantics: every
 *  store error REJECTS; `getPassword()` resolves `undefined` when there is no entry). */
interface KeyringEntry {
  getPassword(): Promise<string | undefined | null>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

type EntryAccess = { entry: KeyringEntry } | { entry: null; detail: string };

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function loadKeyring(): Promise<KeyringModule> {
  return await import("@napi-rs/keyring");
}

async function runningInSea(): Promise<boolean> {
  try {
    const sea = (await import("node:sea")) as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

/** Test seams for `KeyringStore`. Hosts never need them. */
export interface KeyringStoreOptions {
  /** Load the keyring module; reject when it is unavailable. Default: `import("@napi-rs/keyring")`. */
  loadKeyring?: () => Promise<KeyringModule>;
  /** Default `process.platform`. On Linux every entry is pinned to the Secret Service. */
  platform?: NodeJS.Platform;
  /** Default: `node:sea`'s `isSea()`. Only EXPLAINS an unavailable keyring in `detail`. */
  isSea?: () => Promise<boolean> | boolean;
  /** Test seam for the device-id anchor; see `FileStoreOptions.readAnchor`. */
  readAnchor?: () => string | null;
}

/**
 * OS-keyring token store with an explicit 0600 file fallback, and a `status()` that says which
 * one holds the token (P1b-09 plan §5.5, security finding R4-11).
 *
 * THE INVARIANT: the 0600 token file exists only when the last token write fell back, because
 * a VERIFIED keyring write (set, then read back) removes it. So:
 *
 * - reads are keyring-first: a token the keyring holds wins over the file, so a plaintext file
 *   planted or left stale beside a working keyring never shadows it, and the stale
 *   file is removed. The file is read only when the keyring has no token or cannot be read;
 * - a fallen-back write also deletes the keyring entry, best effort, so no older token stays
 *   there for another reader;
 * - `status()` reports `file` exactly when `getToken` would return the file's token or the
 *   keyring cannot be read.
 *
 * On Linux, entries are pinned to the Secret Service. Without the pin `@napi-rs/keyring` falls
 * back to the kernel keyring (keyutils), which is in memory and does not survive a reboot; with
 * it, a headless host gets the file and a `keyring-unavailable` status instead.
 */
export class KeyringStore implements Store {
  private readonly files: FileStore;
  private readonly tokenPath: string;
  private readonly service: string;
  private readonly account = "device-token";
  private readonly load: () => Promise<KeyringModule>;
  private readonly platform: NodeJS.Platform;
  private readonly isSea: () => Promise<boolean> | boolean;

  constructor(
    productSlug: string,
    configDir: string,
    options: KeyringStoreOptions = {},
  ) {
    this.files = new FileStore(productSlug, configDir, {
      readAnchor: options.readAnchor,
    });
    this.tokenPath = join(configDir, productSlug, "token");
    // Rebranded with the rest of the identifier registry (§8). Pre-launch, so there is no
    // `pkey:` entry to migrate — a host that somehow has one simply re-activates.
    this.service = `pkey:${productSlug}`;
    this.load = options.loadKeyring ?? loadKeyring;
    this.platform = options.platform ?? process.platform;
    this.isSea = options.isSea ?? runningInSea;
  }

  /** The module loads and the entry constructs, or why not. Never throws. */
  private async access(): Promise<EntryAccess> {
    let mod: KeyringModule;
    try {
      mod = await this.load();
    } catch (err) {
      const sea = await Promise.resolve()
        .then(() => this.isSea())
        .catch(() => false);
      return {
        entry: null,
        detail: sea
          ? "the @napi-rs/keyring native addon cannot load inside a Node single-executable build"
          : `the @napi-rs/keyring module could not be loaded (${messageOf(err)})`,
      };
    }
    try {
      const entry = new mod.AsyncEntry(
        this.service,
        this.account,
        this.platform === "linux"
          ? { linux: { store: "secret-service" } }
          : undefined,
      );
      return { entry };
    } catch (err) {
      return {
        entry: null,
        detail:
          this.platform === "linux"
            ? `no Secret Service is available (${messageOf(err)})`
            : messageOf(err),
      };
    }
  }

  async getToken() {
    const access = await this.access();
    if (access.entry) {
      try {
        const fromKeyring = (await access.entry.getPassword()) || null;
        if (fromKeyring) {
          // The keyring verified: a file beside it is stale (or planted).
          try {
            rmSync(this.tokenPath, { force: true });
          } catch {
            // Reads stay keyring-first either way.
          }
          return fromKeyring;
        }
      } catch {
        // Unreadable keyring: the file fallback below.
      }
    }
    return await this.files.getToken();
  }

  async setToken(token: string) {
    const access = await this.access();
    if (access.entry) {
      let verified = false;
      try {
        await access.entry.setPassword(token);
        verified = (await access.entry.getPassword()) === token;
      } catch {
        verified = false;
      }
      if (verified) {
        try {
          rmSync(this.tokenPath, { force: true });
        } catch {
          // Harmless: reads are keyring-first, so a file left beside the keyring never wins.
        }
        return;
      }
    }
    // Throws on failure, as before: losing the token silently is worse than an error.
    await this.files.setToken(token);
    if (access.entry) {
      try {
        await access.entry.deleteCredential();
      } catch {
        // Best effort: the file is now the newer copy.
      }
    }
  }

  async clearToken() {
    const access = await this.access();
    if (access.entry) {
      try {
        await access.entry.deleteCredential();
      } catch {
        // Ignore missing/unavailable keyring entries.
      }
    }
    await this.files.clearToken();
  }

  async status(): Promise<StoreStatus> {
    try {
      const access = await this.access();
      if (!access.entry)
        return {
          backend: "file",
          degraded: { reason: "keyring-unavailable", detail: access.detail },
        };
      let held: string | undefined | null;
      try {
        held = await access.entry.getPassword();
      } catch (err) {
        return {
          backend: "file",
          degraded: { reason: "keyring-error", detail: messageOf(err) },
        };
      }
      if (!held && (await this.files.getToken()))
        return {
          backend: "file",
          degraded: {
            reason: "keyring-error",
            detail:
              "an earlier write fell back to this file; the next token write moves it to the keyring",
          },
        };
      return { backend: "keyring" };
    } catch (err) {
      return {
        backend: "file",
        degraded: { reason: "keyring-error", detail: messageOf(err) },
      };
    }
  }

  getDeviceId() {
    return this.files.getDeviceId();
  }

  setDeviceId(id: string) {
    return this.files.setDeviceId(id);
  }

  readAnchor() {
    return this.files.readAnchor();
  }

  readCache() {
    return this.files.readCache();
  }

  writeCache(rec: CacheRecordV3) {
    return this.files.writeCache(rec);
  }

  clearCache() {
    return this.files.clearCache();
  }
}

/** A random fallback identity for hosts whose machine id could not be read. Exported so the
 *  local-only profile can construct a store without touching platform probes. */
export function randomFallbackId(): string {
  return randomUUID();
}

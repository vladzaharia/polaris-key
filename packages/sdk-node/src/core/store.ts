// Persistence: the per-device `pkeyt_` token and the Core-owned offline cache record.
//
// The SHAPE of what is stored (`Store`, `CacheRecordV3`, `CACHE_VERSION`) is isomorphic and
// lives in `@polaris-key/client-core`; only the Node-flavoured implementations are here. The default
// `KeyringStore` keeps the token in the OS keyring when one is available and falls back to
// explicit 0600 file storage for headless/CI hosts; tests use `InMemoryStore`.
//
// A store is DUMB on purpose: it round-trips bytes and knows nothing about versions, verification
// or migration. Discarding a `v !== 3` record is `CacheManager`'s decision (§4.1), because that
// is a security rule, and a security rule that lived in three store implementations would be a
// security rule with three chances to be wrong.
//
// What the store DOES own is the file handle. `writeSecure`/`readSecure` open with `O_NOFOLLOW`
// and bound the read at `MAX_STATE_FILE_BYTES`, because mode 0600 at creation says nothing about
// what is at the path on the NEXT run (B1-04/B1-07). Swift's `KeychainStore` has the same pair.

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import {
  CACHE_VERSION,
  type CacheRecordV3,
  type Store,
} from "@polaris-key/client-core";
import { deriveDeviceId } from "../devices/deviceId.js";

export { CACHE_VERSION };
export type { CacheRecordV3, Store };

/** In-memory store for tests. */
export class InMemoryStore implements Store {
  private token: string | null = null;
  private cache: CacheRecordV3 | null = null;
  private deviceId: string;

  constructor(productSlug = "test") {
    this.deviceId = deriveDeviceId(productSlug);
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
}

/** Largest on-disk state file this store will read, in bytes.
 *
 *  Mode 0600 was applied only AT CREATION, and the read was a plain `readFileSync` — so a
 *  symlink planted at the path redirected the read to a file the attacker chose, and a huge
 *  file at the path was slurped whole into this process (B1-04/B1-07). The cap bounds the
 *  second half of that.
 *
 *  Three files live under the product directory: the `pkeyt_` token, a 32-char device id, and
 *  `managed.json`. The record is at most three compact JWSs plus a few unsigned hints — a
 *  signed document's payload is capped at `MAX_DOC_BYTES` (64 KiB) and base64url-encodes to
 *  ~87 KiB, so a legitimate record sits comfortably under 300 KiB even with trust, license and
 *  config all at the cap. (`MAX_BUNDLE_BYTES`, 256 KiB, does NOT apply: `importedBundle`
 *  persists a marker — `bundleId` plus a timestamp — never the bundle JWS.) 1 MiB is the same
 *  number Swift's `KeychainStore.maxCacheBytes` uses, chosen the same way: several times any
 *  legitimate record, and nowhere near "read the attacker's 8 GiB file". */
export const MAX_STATE_FILE_BYTES = 1024 * 1024;

/** How the symlink refusal is enforced on this platform.
 *
 *  `"O_NOFOLLOW"`     — the kernel refuses the `open(2)` atomically. POSIX; verified present
 *    in `fs.constants` on Node 22 for darwin and linux.
 *  `"lstat-precheck"` — `fs.constants.O_NOFOLLOW` is undefined (Windows). We `lstat` the
 *    target and refuse a link before opening. Best-effort and TOCTOU-racy rather than the
 *    atomic guarantee POSIX gives, but an explicit, documented degradation instead of
 *    `| undefined` silently OR-ing a zero into the flags and leaving the comment promising a
 *    protection that was not there. Mirrors `SYMLINK_GUARD` in the Python SDK.
 *
 *  There is deliberately no `O_CLOEXEC` here: Node does not expose the constant at all
 *  (it is absent from `fs.constants` and from `@types/node`) because libuv opens EVERY
 *  descriptor close-on-exec already. The flag Swift has to pass explicitly is unconditional
 *  in this runtime. */
export const SYMLINK_GUARD: "O_NOFOLLOW" | "lstat-precheck" =
  typeof fsc.O_NOFOLLOW === "number" ? "O_NOFOLLOW" : "lstat-precheck";

const NOFOLLOW = SYMLINK_GUARD === "O_NOFOLLOW" ? fsc.O_NOFOLLOW : 0;

/** Refuse a symlinked target on a platform without `O_NOFOLLOW`. No-op where the kernel
 *  already answers the question atomically. */
function refuseLinkedPath(path: string): void {
  if (SYMLINK_GUARD === "O_NOFOLLOW") return;
  let linked = false;
  try {
    linked = lstatSync(path).isSymbolicLink();
  } catch {
    return; // Absent is fine; `openSync` decides.
  }
  if (linked) {
    throw Object.assign(new Error(`refusing to follow a symlink at ${path}`), {
      code: "ELOOP",
      path,
    });
  }
}

function writeSecure(path: string, data: string): void {
  // O_NOFOLLOW refuses to follow a planted symlink at the target.
  refuseLinkedPath(path);
  const fd = openSync(
    path,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | NOFOLLOW,
    0o600,
  );
  try {
    // The creation mode applies only to a NEW file; repair a pre-existing loose one, exactly
    // as Swift's `writeSecure` does with `fchmod`.
    fchmodSyncSafe(fd);
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** `fchmod` is unimplemented on some Windows/network filesystems; a failure to TIGHTEN a mode
 *  must not fail the write that was already going to happen. */
function fchmodSyncSafe(fd: number): void {
  try {
    fchmodSync(fd, 0o600);
  } catch {
    /* best effort */
  }
}

/** Read `path` refusing to follow a symlink and bounding the read at
 *  `MAX_STATE_FILE_BYTES`.
 *
 *  Every refusal — absent, symlinked (`ELOOP`/`EMLINK`), not a regular file, over the cap,
 *  unreadable — returns `null`, which is this store's single spelling of ABSENT. That is the
 *  codebase's standing convention for a failed artifact (§4.1: a missing, unreadable or
 *  unparseable cache is "no cache", which Core treats as needs-activation) and it is what
 *  keeps a planted file from being either trusted OR fatal. */
function readSecure(path: string): string | null {
  let fd: number;
  try {
    refuseLinkedPath(path);
    fd = openSync(path, fsc.O_RDONLY | NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    // A directory, FIFO or device node at this path is not the file we wrote.
    if (!st.isFile()) return null;
    if (st.size > MAX_STATE_FILE_BYTES) return null;
    const buf = Buffer.allocUnsafe(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break; // Truncated under us; use what we got.
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** 0600 file-backed store under `<configDir>/<product>/`. */
export class FileStore implements Store {
  private readonly dir: string;
  private readonly tokenPath: string;
  private readonly cachePath: string;
  private readonly devicePath: string;

  constructor(
    private readonly productSlug: string,
    configDir: string,
  ) {
    this.dir = join(configDir, productSlug);
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.tokenPath = join(this.dir, "token");
    this.cachePath = join(this.dir, "managed.json");
    this.devicePath = join(this.dir, "device");
  }

  async getToken() {
    return readSecure(this.tokenPath)?.trim() || null;
  }
  async setToken(t: string) {
    writeSecure(this.tokenPath, t);
  }
  async clearToken() {
    rmSync(this.tokenPath, { force: true });
  }
  async getDeviceId() {
    const existing = readSecure(this.devicePath)?.trim();
    if (existing) return existing;
    const id = deriveDeviceId(this.productSlug);
    writeSecure(this.devicePath, id);
    return id;
  }
  async readCache(): Promise<CacheRecordV3 | null> {
    const raw = readSecure(this.cachePath);
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
}

type KeyringModule = typeof import("@napi-rs/keyring");

async function loadKeyring(): Promise<KeyringModule | null> {
  try {
    return await import("@napi-rs/keyring");
  } catch {
    return null;
  }
}

/** OS-keyring token store with FileStore fallback for cache/device id and headless hosts. */
export class KeyringStore implements Store {
  private readonly files: FileStore;
  private readonly service: string;
  private readonly account = "device-token";

  constructor(productSlug: string, configDir: string) {
    this.files = new FileStore(productSlug, configDir);
    // Rebranded with the rest of the identifier registry (§8). Pre-launch, so there is no
    // `pkey:` entry to migrate — a host that somehow has one simply re-activates.
    this.service = `pkey:${productSlug}`;
  }

  async getToken() {
    const keyring = await loadKeyring();
    if (keyring) {
      try {
        return (
          (await new keyring.AsyncEntry(
            this.service,
            this.account,
          ).getPassword()) ?? null
        );
      } catch {
        // Fall through to explicit file fallback.
      }
    }
    return this.files.getToken();
  }

  async setToken(token: string) {
    const keyring = await loadKeyring();
    if (keyring) {
      try {
        await new keyring.AsyncEntry(this.service, this.account).setPassword(
          token,
        );
        await this.files.clearToken();
        return;
      } catch {
        // Fall through to explicit file fallback.
      }
    }
    await this.files.setToken(token);
  }

  async clearToken() {
    const keyring = await loadKeyring();
    if (keyring) {
      try {
        await new keyring.AsyncEntry(
          this.service,
          this.account,
        ).deleteCredential();
      } catch {
        // Ignore missing/unavailable keyring entries.
      }
    }
    await this.files.clearToken();
  }

  getDeviceId() {
    return this.files.getDeviceId();
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

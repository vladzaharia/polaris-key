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

import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsc,
  mkdirSync,
  openSync,
  readFileSync,
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

function writeSecure(path: string, data: string): void {
  // O_NOFOLLOW refuses to follow a planted symlink at the target.
  const fd = openSync(
    path,
    fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW,
    0o600,
  );
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function readMaybe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
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
    if (existing) return existing;
    const id = deriveDeviceId(this.productSlug);
    writeSecure(this.devicePath, id);
    return id;
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

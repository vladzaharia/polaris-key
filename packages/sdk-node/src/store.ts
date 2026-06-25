// Persistence: the per-machine token, a stable device id, and the offline-first config
// cache. The default KeyringStore keeps the token in the OS keyring when available and
// falls back to explicit 0600 file storage for headless/CI environments; tests use
// InMemoryStore.

import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
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
import type {
  AllowedRange,
  BlockReason,
  ManagedConfigDoc,
} from "@polaris-key/protocol";
import type { TrustSet } from "@polaris-key/jws";

/** Bookkeeping shared by both cache shapes (doc-bearing and doc-less). */
interface CacheBookkeeping {
  etag?: string;
  lastAcceptedIssuedAt: number;
  lastVerifiedAt?: number;
  lastSyncUnauthorized?: boolean;
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
  trustedKeys?: TrustSet;
  lastTrustIssuedAt?: number;
}

/** The offline cache. A discriminated union on `doc`: a verified doc is present after a
 *  successful /config, or `doc: null` for the bookkeeping-only record `patchCache` writes
 *  when the FIRST sync is blocked/unauthorized (so there is no doc yet to apply). The
 *  null arm makes the doc-less state type-honest — every getter must narrow on `doc`. */
export type CacheRecord =
  | (CacheBookkeeping & { doc: ManagedConfigDoc })
  | (CacheBookkeeping & { doc: null });

export interface Store {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  getDeviceId(): Promise<string>;
  readCache(): Promise<CacheRecord | null>;
  writeCache(rec: CacheRecord): Promise<void>;
  clearCache(): Promise<void>;
}

function rawMachineId(): string | null {
  try {
    if (process.platform === "darwin") {
      const out = execFileSync(
        "ioreg",
        ["-rd1", "-c", "IOPlatformExpertDevice"],
        { encoding: "utf8" },
      );
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      return m?.[1] ?? null;
    }
    if (process.platform === "win32") {
      const out = execFileSync(
        "reg",
        [
          "query",
          "HKLM\\SOFTWARE\\Microsoft\\Cryptography",
          "/v",
          "MachineGuid",
        ],
        { encoding: "utf8" },
      );
      const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/);
      return m?.[1] ?? null;
    }
    const id = readFileSync("/etc/machine-id", "utf8").trim();
    return id || readFileSync("/var/lib/dbus/machine-id", "utf8").trim();
  } catch {
    return null;
  }
}

/** Derive a stable, hashed device id so the raw machine id never leaves the device. */
export function deriveDeviceId(
  productSlug: string,
  fallback?: string | null,
): string {
  const base = rawMachineId() ?? fallback ?? randomUUID();
  return createHash("sha256")
    .update(`pkey-device:${productSlug}:${base}`)
    .digest("base64url")
    .slice(0, 32);
}

/** In-memory store for tests. */
export class InMemoryStore implements Store {
  private token: string | null = null;
  private cache: CacheRecord | null = null;
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
  async writeCache(rec: CacheRecord) {
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
  async readCache(): Promise<CacheRecord | null> {
    const raw = readMaybe(this.cachePath);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as CacheRecord;
    } catch {
      return null;
    }
  }
  async writeCache(rec: CacheRecord) {
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
  private readonly account = "machine-token";

  constructor(productSlug: string, configDir: string) {
    this.files = new FileStore(productSlug, configDir);
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

  writeCache(rec: CacheRecord) {
    return this.files.writeCache(rec);
  }

  clearCache() {
    return this.files.clearCache();
  }
}

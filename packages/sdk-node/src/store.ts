// Persistence: the per-device token, a stable device id, and the offline-first config
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
import type { AllowedRange, BlockReason } from "@polaris-key/protocol";

/** On-disk cache format version. A record carrying any other value is DISCARDED, never
 *  migrated (wire contract v2 §7.3) — one network round trip is the correct price for not
 *  carrying poisoned state forward. */
export const CACHE_VERSION = 2;

/**
 * The offline cache — wire contract v2 §4.1.
 *
 * It stores SIGNED ARTIFACTS ONLY: the compact JWS of the managed-config document and of the
 * trust manifest, both re-verified against the PINNED keys on every load. The v1 record
 * persisted the *decoded* doc, a bare `trustedKeys` map, and three unsigned counters
 * (`lastAcceptedIssuedAt`, `lastTrustIssuedAt`, `lastVerifiedAt`) that security decisions
 * read directly — so one write to a plain JSON file was enough to substitute the key bytes
 * behind a pinned kid (R2-01/R4-02), pin forged state against a live server (R4-03), or
 * invent a licence outright with no signature anywhere (R2-03/R4-01). All three counters are
 * now DERIVED from re-verified content and are never read from disk.
 *
 * `blocked` and `lastSyncUnauthorized` remain unsigned deliberately: they only ever make the
 * gate STRICTER, so clearing them gains an attacker nothing that deleting the file would not.
 */
export interface CacheRecord {
  v: typeof CACHE_VERSION;
  /** The compact JWS of the managed-config document, verbatim. */
  configJws?: string;
  /** The compact JWS of the trust manifest, verbatim. */
  trustJws?: string;
  /** Non-security hint: the conditional-request validator. */
  etag?: string;
  lastSyncUnauthorized?: boolean;
  blocked?: { reason: BlockReason; allowedRange?: AllowedRange };
}

export interface Store {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  getDeviceId(): Promise<string>;
  readCache(): Promise<CacheRecord | null>;
  writeCache(rec: CacheRecord): Promise<void>;
  clearCache(): Promise<void>;
}

function rawDeviceId(): string | null {
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

/** The device-id formula itself, split out from the hardware read so it can be pinned by
 *  conformance/corpus/v1/fingerprint.json. Node, Python, and Swift must agree here exactly. */
export function deviceIdFromRaw(productSlug: string, raw: string): string {
  return createHash("sha256")
    .update(`pkey-device:${productSlug}:${raw}`, "utf8")
    .digest("base64url")
    .slice(0, 32);
}

/** Derive a stable, hashed device id so the raw OS identifier never leaves the device. */
export function deriveDeviceId(
  productSlug: string,
  fallback?: string | null,
): string {
  return deviceIdFromRaw(
    productSlug,
    rawDeviceId() ?? fallback ?? randomUUID(),
  );
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
  private readonly account = "device-token";

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

// `SafeStorageStore` (SDK parity pass SP-N11): the token store for an Electron main process,
// behind the `core.store` contract. The token is encrypted with Electron's `safeStorage`, whose
// key lives in the OS credential store (Keychain, DPAPI, libsecret or KWallet), and written to a
// 0600 file; the cache and the device id stay in the plain `FileStore` beside it.
//
// Degradation is surfaced, never silent (P1b-09):
//   * `safeStorage.isEncryptionAvailable()` false (before `app.whenReady()`, or no secret store)
//     ⇒ the token goes to the plain 0600 file and `status()` says `keyring-unavailable`;
//   * Linux `basic_text` (Chromium's hard-coded key: obfuscation, not encryption) ⇒ still
//     encrypted, but `status()` says `keyring-unavailable` with that detail;
//   * an encrypted token that no longer decrypts (the OS key was reset) ⇒ `getToken()` is null,
//     `status()` says `keyring-error`, and the next activation writes a fresh one.
//
// The invariant matches KeyringStore's: at most one of `token.enc` and `token` exists after a
// write, so a stale copy can never shadow a newer one.

import {
  closeSync,
  constants as fsc,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import type {
  CacheRecordV3,
  Store,
  StoreStatus,
} from "@polaris-key/client-core";
import { FileStore } from "../core/store.js";

/** The part of Electron's `safeStorage` the store uses. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
  /** Linux only: `basic_text`, `gnome_libsecret`, `kwallet`, `kwallet5`, `kwallet6`, `unknown`. */
  getSelectedStorageBackend?(): string;
}

export interface SafeStorageStoreOptions {
  /** Electron's `safeStorage` (`import { safeStorage } from "electron"`). */
  safeStorage: SafeStorageLike;
  /** Default `process.platform`; `basic_text` is checked on Linux only. */
  platform?: NodeJS.Platform;
}

function writeSecure(path: string, data: Buffer): void {
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

function readMaybe(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SafeStorageStore implements Store {
  private readonly files: FileStore;
  private readonly encPath: string;
  private readonly plainPath: string;
  private readonly safe: SafeStorageLike;
  private readonly platform: NodeJS.Platform;
  /** Why the last decrypt failed, for `status()`. */
  private decryptFailure: string | null = null;

  constructor(
    productSlug: string,
    configDir: string,
    opts: SafeStorageStoreOptions,
  ) {
    this.files = new FileStore(productSlug, configDir);
    this.encPath = join(configDir, productSlug, "token.enc");
    this.plainPath = join(configDir, productSlug, "token");
    this.safe = opts.safeStorage;
    this.platform = opts.platform ?? process.platform;
  }

  private available(): boolean {
    try {
      return this.safe.isEncryptionAvailable();
    } catch {
      return false;
    }
  }

  async getToken(): Promise<string | null> {
    // A plain file exists only when the last write fell back, so it is the newest copy.
    const plain = await this.files.getToken();
    if (plain) return plain;
    const enc = readMaybe(this.encPath);
    if (!enc || enc.length === 0) return null;
    if (!this.available()) {
      this.decryptFailure = "safeStorage encryption is not available yet";
      return null;
    }
    try {
      const token = this.safe.decryptString(enc).trim();
      this.decryptFailure = null;
      return token || null;
    } catch (err) {
      this.decryptFailure = `the stored token no longer decrypts (${messageOf(err)})`;
      return null;
    }
  }

  async setToken(token: string): Promise<void> {
    if (this.available()) {
      let enc: Buffer | null = null;
      try {
        enc = this.safe.encryptString(token);
      } catch {
        enc = null;
      }
      if (enc && enc.length > 0) {
        writeSecure(this.encPath, enc);
        rmSync(this.plainPath, { force: true });
        this.decryptFailure = null;
        return;
      }
    }
    // Surfaced through status(): the token is in a plain 0600 file.
    await this.files.setToken(token);
    rmSync(this.encPath, { force: true });
  }

  async clearToken(): Promise<void> {
    rmSync(this.encPath, { force: true });
    await this.files.clearToken();
    this.decryptFailure = null;
  }

  async status(): Promise<StoreStatus> {
    if (!this.available())
      return {
        backend: "file",
        degraded: {
          reason: "keyring-unavailable",
          detail:
            "Electron safeStorage encryption is not available (call it after app.whenReady(); on Linux a secret store is needed)",
        },
      };
    if (await this.files.getToken())
      return {
        backend: "file",
        degraded: {
          reason: "keyring-error",
          detail:
            "an earlier write fell back to a plain file; the next token write encrypts it",
        },
      };
    if (this.decryptFailure)
      return {
        backend: "file",
        degraded: { reason: "keyring-error", detail: this.decryptFailure },
      };
    if (this.platform === "linux") {
      let backend = "unknown";
      try {
        backend = this.safe.getSelectedStorageBackend?.() ?? "unknown";
      } catch {
        backend = "unknown";
      }
      if (backend === "basic_text")
        return {
          backend: "file",
          degraded: {
            reason: "keyring-unavailable",
            detail:
              "safeStorage fell back to basic_text: no Secret Service or KWallet, so the token is only obfuscated",
          },
        };
    }
    return { backend: "keyring" };
  }

  setDeviceId(id: string): Promise<void> {
    return this.files.setDeviceId(id);
  }

  readAnchor(): string | null {
    return this.files.readAnchor();
  }

  getDeviceId(): Promise<string> {
    return this.files.getDeviceId();
  }

  readCache(): Promise<CacheRecordV3 | null> {
    return this.files.readCache();
  }

  writeCache(rec: CacheRecordV3): Promise<void> {
    return this.files.writeCache(rec);
  }

  clearCache(): Promise<void> {
    return this.files.clearCache();
  }
}

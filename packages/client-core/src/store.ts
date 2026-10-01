// Persistence CONTRACT — types only, wire contract v3 §4.1.
//
// This package is isomorphic (WebCrypto, zero Node APIs), so it declares the shape of a store
// and nothing that touches a disk, a keyring, or `localStorage`. The concrete implementations
// live with their host: `FileStore`/`KeyringStore` in @polaris-key/node, the browser/desktop stores
// in @polaris-key/react, `KeychainStore` in Swift.

import type { BlockedState } from "./gate.js";

/** On-disk cache format version. A record carrying any other value is DISCARDED, never
 *  migrated (§4.1) — one network round trip is the correct price for not carrying poisoned
 *  state forward, and an air-gapped install re-imports its bundle. */
export const CACHE_VERSION = 3;

/**
 * The offline cache — one Core-owned record per product.
 *
 * It stores SIGNED ARTIFACTS ONLY: the compact JWS of each per-service document and of the
 * trust manifest, all re-verified (trust against PINS, documents against the effective set,
 * `checkFreshness: false`) on every load. Nothing decoded, no bare keys, no plaintext
 * counters: the v1 record persisted the *decoded* doc, a bare `trustedKeys` map, and three
 * unsigned counters that security decisions read directly — so one write to a plain JSON file
 * was enough to substitute the key bytes behind a pinned kid (R2-01/R4-02), pin forged state
 * against a live server (R4-03), or invent a licence outright with no signature anywhere
 * (R2-03/R4-01). Those counters are now DERIVED from re-verified content.
 *
 * `blocked` and `lastSyncUnauthorized` remain unsigned deliberately: they only ever make the
 * gate STRICTER, so clearing them gains an attacker nothing that deleting the file would not.
 *
 * v3 change: `configJws`/`etag` become per-service SLICES (`docs`/`etags`), because license
 * and config are now two independently-fetched, independently-ETagged documents; and
 * `importedBundle` records an offline activation (§7).
 */
export interface CacheRecordV3 {
  v: typeof CACHE_VERSION;
  /** The compact JWS of the trust manifest, verbatim. */
  trustJws?: string;
  /** Per-service signed documents. An absent slice means the service is unused by this
   *  product, or has not been fetched yet — never that it failed open. */
  docs?: { license?: string; config?: string };
  /** Non-security hints: the per-document conditional-request validators. */
  etags?: { license?: string; config?: string };
  /** Set by `importBundle` (§7). Present with a verified license doc ⇒ `activation: "bundle"`;
   *  a later online activation supersedes it with `activation: "token"`. */
  importedBundle?: { bundleId: string; importedAt: number };
  /** A recorded hard 401 — the offline revocation signal (§4.3). */
  lastSyncUnauthorized?: boolean;
  /** The last 403 version/channel block from `GET /<p>/license/document`. */
  blocked?: BlockedState;
}

/**
 * Where a token store keeps the token. Stable identifiers, shared with every SDK's
 * `storeStatus()` / `store_status()` surface (P1b-09 plan §2.3).
 */
export const STORE_BACKENDS = [
  /** An OS credential store: Secret Service, Credential Manager, the macOS login keychain
   *  through a keyring library. */
  "keyring",
  /** The Apple Keychain through Security.framework. */
  "keychain",
  /** An Android Keystore key wrapping the token. */
  "keystore",
  /** A 0600 file. */
  "file",
  /** Nothing persists (tests). */
  "memory",
  /** Browser storage (Godot web). */
  "indexeddb",
  /** A host store that fits none of these. */
  "custom",
] as const;
export type StoreBackend = (typeof STORE_BACKENDS)[number];

/** Why a store is weaker than this platform's best option. Stable identifiers. */
export const STORE_DEGRADED_REASONS = [
  /** The OS keyring cannot be loaded, or its pinned store is absent; the token is in a file. */
  "keyring-unavailable",
  /** The keyring loaded but an operation failed, now or in the write that left the token in
   *  a file. */
  "keyring-error",
  /** macOS: no data-protection keychain entitlement; the file-based keychain is used. */
  "legacy-keychain",
  /** Storage may be evicted or may not survive a restart. */
  "not-persistent",
] as const;
export type StoreDegradedReason = (typeof STORE_DEGRADED_REASONS)[number];

/** What `Store.status()` reports. `detail` is human text and never contains the token. */
export interface StoreStatus {
  backend: StoreBackend;
  degraded?: { reason: StoreDegradedReason; detail?: string };
}

/**
 * The credential + cache surface a host provides. Writes to the cache are Core-mediated
 * read-modify-write of the WHOLE record; service modules never write it directly (§4.1).
 */
export interface Store {
  getToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  clearToken(): Promise<void>;
  getDeviceId(): Promise<string>;
  readCache(): Promise<CacheRecordV3 | null>;
  writeCache(rec: CacheRecordV3): Promise<void>;
  clearCache(): Promise<void>;
  /** Where the token lives now, and why if that is weaker than this platform's best option.
   *  Optional; never throws; `detail` is human text and never contains the token. */
  status?(): Promise<StoreStatus>;
}

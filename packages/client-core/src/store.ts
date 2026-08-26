// Persistence CONTRACT — types only, wire contract v3 §4.1.
//
// This package is isomorphic (WebCrypto, zero Node APIs), so it declares the shape of a store
// and nothing that touches a disk, a keyring, or `localStorage`. The concrete implementations
// live with their host: `FileStore`/`KeyringStore` in @plrs/node, the browser/desktop stores
// in @plrs/react, `KeychainStore` in Swift.

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
}
